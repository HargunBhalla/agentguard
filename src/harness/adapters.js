/**
 * CRM adapters.
 *
 * Everything above this file speaks one vocabulary: the normalized operations
 * in ops.js and the stages in schema.js. An adapter is the translation down to
 * one provider — its object names, its stage values, the request it would
 * actually issue, and what it is willing to undo.
 *
 * The last of those is the interesting one. Reversibility is not a property of
 * the operation, it is a property of the provider: archiving a HubSpot record
 * is restorable for 90 days, deleting a Salesforce record drops it in a recycle
 * bin, and deleting an Attio record is gone. An agent that is safe on one CRM
 * is therefore not automatically safe on another, and recovery.js reads that
 * difference off the adapter rather than assuming a rollback always exists.
 *
 * Native requests are recorded on every span but never sent — the harness runs
 * entirely against the shadow world. They are here so a trace shows the call a
 * live deployment would have made, and so an adapter's mapping is reviewable.
 */

import { STAGES } from './schema.js';

/**
 * Reversibility classes, in the order recovery.js escalates through them.
 *
 *   reversible    an exact inverse exists (delete what was created).
 *   compensable   no inverse, but the prior values were captured and can be
 *                 written back — the record's history shows both writes.
 *   irreversible  cannot be undone by any sequence of API calls. These are the
 *                 operations that have to be stopped before they run, because
 *                 afterwards there is nothing to stop.
 */
export const REVERSIBILITY = ['reversible', 'compensable', 'irreversible'];

/** Applies unless an adapter overrides it. */
const BASE_REVERSIBILITY = {
  search_records: 'reversible',
  get_record: 'reversible',
  create_record: 'reversible',
  update_record: 'compensable',
  delete_record: 'compensable',
  change_stage: 'compensable',
  assign_owner: 'compensable',
  merge_records: 'irreversible',
  create_task: 'reversible',
  add_note: 'reversible',
};

function makeAdapter(spec) {
  const reversibility = { ...BASE_REVERSIBILITY, ...(spec.reversibility || {}) };
  return {
    ...spec,
    reversibility,
    /** Native object name for a normalized type, or null if unsupported. */
    object: (type) => spec.objects[type] ?? null,
    supports: (type) => spec.objects[type] != null,
    /**
     * Native stage value. Adapters whose pipeline is coarser than the canonical
     * one map several stages onto the same value — see `collapses` below.
     */
    stage: (s) => spec.stages[s] ?? s,
    /**
     * Canonical stages this adapter cannot tell apart, as a map from native
     * value to the stages that share it. A stage change between two of them
     * issues a write that changes nothing on the provider, which is a
     * portability defect worth showing rather than hiding.
     */
    get collapses() {
      const byNative = {};
      for (const s of STAGES) (byNative[spec.stages[s] ?? s] ||= []).push(s);
      return Object.fromEntries(Object.entries(byNative).filter(([, v]) => v.length > 1));
    },
    /** What this provider will let you take back after `op` has run. */
    class: (op) => reversibility[op] ?? 'compensable',
  };
}

export const hubspot = makeAdapter({
  id: 'hubspot',
  label: 'HubSpot',
  base: '/crm/v3',
  objects: {
    company: 'companies',
    contact: 'contacts',
    deal: 'deals',
    // HubSpot models a lead as a contact with a lifecycle stage rather than a
    // separate object, so the type exists but shares the contacts endpoint.
    lead: 'contacts',
    task: 'tasks',
    note: 'notes',
    owner: 'owners',
  },
  stages: {
    Discovery: 'appointmentscheduled',
    Qualified: 'qualifiedtobuy',
    Proposal: 'presentationscheduled',
    Negotiation: 'decisionmakerboughtin',
    'Closed Won': 'closedwon',
    'Closed Lost': 'closedlost',
  },
  // Archived records are restorable from the UI for 90 days, so a delete here
  // is recoverable in a way it is not everywhere else.
  reversibility: { delete_record: 'compensable' },
  cost: { search_records: 180, get_record: 90, create_record: 140, update_record: 130, delete_record: 120, change_stage: 130, assign_owner: 120, merge_records: 260, create_task: 110, add_note: 100 },
  native(op, a) {
    const obj = this.objects[a.type] ?? 'objects';
    const at = `${this.base}/objects/${obj}`;
    switch (op) {
      case 'search_records': return { method: 'POST', path: `${at}/search`, body: { filterGroups: a.where ?? {}, limit: a.limit ?? 100 } };
      case 'get_record': return { method: 'GET', path: `${at}/${a.id}` };
      case 'create_record': return { method: 'POST', path: at, body: { properties: a.values } };
      case 'update_record': return { method: 'PATCH', path: `${at}/${a.id}`, body: { properties: a.patch } };
      case 'delete_record': return { method: 'DELETE', path: `${at}/${a.id}`, note: 'archive — restorable for 90 days' };
      case 'change_stage': return { method: 'PATCH', path: `${this.base}/objects/deals/${a.id}`, body: { properties: { dealstage: this.stages[a.to] } } };
      case 'assign_owner': return { method: 'PATCH', path: `${at}/${a.id}`, body: { properties: { hubspot_owner_id: a.owner } } };
      case 'merge_records': return { method: 'POST', path: `${at}/merge`, body: { primaryObjectId: a.primary, objectIdToMerge: a.duplicate } };
      case 'create_task': return { method: 'POST', path: `${this.base}/objects/tasks`, body: { properties: { hs_task_subject: a.subject, hubspot_owner_id: a.owner } } };
      case 'add_note': return { method: 'POST', path: `${this.base}/objects/notes`, body: { properties: { hs_note_body: a.body } } };
      default: return { method: 'POST', path: at };
    }
  },
});

export const salesforce = makeAdapter({
  id: 'salesforce',
  label: 'Salesforce',
  base: '/services/data/v60.0',
  objects: {
    company: 'Account',
    contact: 'Contact',
    deal: 'Opportunity',
    lead: 'Lead',
    task: 'Task',
    note: 'Note',
    owner: 'User',
  },
  stages: {
    Discovery: 'Prospecting',
    Qualified: 'Qualification',
    Proposal: 'Proposal/Price Quote',
    Negotiation: 'Negotiation/Review',
    'Closed Won': 'Closed Won',
    'Closed Lost': 'Closed Lost',
  },
  // Deleted rows sit in the Recycle Bin for 15 days and can be undeleted.
  reversibility: { delete_record: 'compensable' },
  cost: { search_records: 240, get_record: 120, create_record: 190, update_record: 170, delete_record: 160, change_stage: 170, assign_owner: 160, merge_records: 340, create_task: 150, add_note: 140 },
  native(op, a) {
    const obj = this.objects[a.type] ?? 'sObject';
    const at = `${this.base}/sobjects/${obj}`;
    switch (op) {
      case 'search_records': return { method: 'GET', path: `${this.base}/query`, body: { q: `SELECT Id FROM ${obj}${a.soql ? ` WHERE ${a.soql}` : ''}` } };
      case 'get_record': return { method: 'GET', path: `${at}/${a.id}` };
      case 'create_record': return { method: 'POST', path: at, body: a.values };
      case 'update_record': return { method: 'PATCH', path: `${at}/${a.id}`, body: a.patch };
      case 'delete_record': return { method: 'DELETE', path: `${at}/${a.id}`, note: 'recycle bin — undeletable for 15 days' };
      case 'change_stage': return { method: 'PATCH', path: `${this.base}/sobjects/Opportunity/${a.id}`, body: { StageName: this.stages[a.to] } };
      case 'assign_owner': return { method: 'PATCH', path: `${at}/${a.id}`, body: { OwnerId: a.owner } };
      case 'merge_records': return { method: 'POST', path: `${this.base}/composite/sobjects/merge/${obj}/${a.primary}`, body: { recordToMergeIds: [a.duplicate] } };
      case 'create_task': return { method: 'POST', path: `${this.base}/sobjects/Task`, body: { Subject: a.subject, OwnerId: a.owner, WhatId: a.about } };
      case 'add_note': return { method: 'POST', path: `${this.base}/sobjects/Note`, body: { Body: a.body, ParentId: a.about } };
      default: return { method: 'POST', path: at };
    }
  },
});

export const attio = makeAdapter({
  id: 'attio',
  label: 'Attio',
  base: '/v2',
  objects: {
    company: 'companies',
    contact: 'people',
    deal: 'deals',
    // Attio has no Lead object — inbound records live on a list instead, so a
    // workflow written against leads has nowhere to land here.
    lead: null,
    task: 'tasks',
    note: 'notes',
    owner: 'workspace_members',
  },
  // The default Attio deal pipeline is coarser than the canonical one: Proposal
  // and Negotiation are both "In Progress". Moving a deal between them issues a
  // write that changes nothing.
  stages: {
    Discovery: 'Lead',
    Qualified: 'Qualified',
    Proposal: 'In Progress',
    Negotiation: 'In Progress',
    'Closed Won': 'Won',
    'Closed Lost': 'Lost',
  },
  // Deletes are permanent, and there is no merge endpoint — a "merge" is a
  // relink followed by a delete, so both are one-way doors.
  reversibility: { delete_record: 'irreversible', merge_records: 'irreversible' },
  cost: { search_records: 120, get_record: 60, create_record: 100, update_record: 95, delete_record: 90, change_stage: 95, assign_owner: 85, merge_records: 210, create_task: 80, add_note: 70 },
  native(op, a) {
    const obj = this.objects[a.type];
    const at = `${this.base}/objects/${obj}/records`;
    switch (op) {
      case 'search_records': return { method: 'POST', path: `${at}/query`, body: { filter: a.where ?? {}, limit: a.limit ?? 100 } };
      case 'get_record': return { method: 'GET', path: `${at}/${a.id}` };
      case 'create_record': return { method: 'PUT', path: at, body: { data: { values: a.values } } };
      case 'update_record': return { method: 'PATCH', path: `${at}/${a.id}`, body: { data: { values: a.patch } } };
      case 'delete_record': return { method: 'DELETE', path: `${at}/${a.id}`, note: 'permanent — no recycle bin' };
      case 'change_stage': return { method: 'PATCH', path: `${this.base}/objects/deals/records/${a.id}`, body: { data: { values: { stage: this.stages[a.to] } } } };
      case 'assign_owner': return { method: 'PATCH', path: `${at}/${a.id}`, body: { data: { values: { owner: a.owner } } } };
      case 'merge_records': return { method: 'DELETE', path: `${at}/${a.duplicate}`, note: `relink to ${a.primary}, then permanent delete — no merge endpoint` };
      case 'create_task': return { method: 'POST', path: `${this.base}/tasks`, body: { data: { content: a.subject, assignees: [a.owner] } } };
      case 'add_note': return { method: 'POST', path: `${this.base}/notes`, body: { data: { content: a.body, parent_record_id: a.about } } };
      default: return { method: 'POST', path: at };
    }
  },
});

export const ADAPTERS = [hubspot, salesforce, attio];

export const adapterById = (id) => ADAPTERS.find((a) => a.id === id) ?? hubspot;
