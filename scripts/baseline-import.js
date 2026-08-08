#!/usr/bin/env node
'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');
const { createEventStore, CURRENT_SCHEMA_VERSION, REQUIRED_PAYLOAD_KEYS_V2 } = require('../src/event-store');

const ACTIVE_SUFFIX = '_reminders.json';
const COMPLETED_SUFFIX = '_completed.json';

/**
 * @param {any} ArgValue
 * @returns {string|null}
 */
function GetNonEmptyString(ArgValue) {
  return typeof ArgValue === 'string' && ArgValue.length > 0 ? ArgValue : null;
}

/**
 * @param {any} ArgValue
 * @returns {string[]}
 */
function GetStringArray(ArgValue) {
  return Array.isArray(ArgValue) ? ArgValue.filter(ArgItem => typeof ArgItem === 'string') : [];
}

/**
 * @param {any} ArgValue
 * @returns {string|null}
 */
function NormalizeIsoString(ArgValue) {
  if(ArgValue instanceof Date) {
    if(Number.isNaN(ArgValue.getTime())) return null;
    return ArgValue.toISOString();
  }

  if(typeof ArgValue === 'number' && Number.isFinite(ArgValue)) {
    const DateValue = new Date(ArgValue);
    if(Number.isNaN(DateValue.getTime())) return null;
    return DateValue.toISOString();
  }

  if(typeof ArgValue === 'string' && ArgValue.length > 0) {
    const DateValue = new Date(ArgValue);
    if(Number.isNaN(DateValue.getTime())) return null;
    return DateValue.toISOString();
  }

  return null;
}

/**
 * @param {string} ArgFilePath
 * @returns {Promise<any[]>}
 */
async function ReadJsonArrayAsync(ArgFilePath) {
  try {
    const Raw = await fs.readFile(ArgFilePath, 'utf8');
    const Parsed = JSON.parse(Raw);
    return Array.isArray(Parsed) ? Parsed : [];
  } catch(error) {
    if(error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * @param {string} ArgRemindersDir
 * @returns {Promise<string[]>}
 */
async function EnumerateWorkspaceNamesAsync(ArgRemindersDir) {
  let Entries = [];
  try {
    Entries = await fs.readdir(ArgRemindersDir, { withFileTypes: true });
  } catch(error) {
    if(error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  /** @type {Set<string>} */
  const WorkspaceNames = new Set();
  for(const Entry of Entries) {
    if(!Entry.isFile()) continue;
    if(Entry.name.endsWith(ACTIVE_SUFFIX)) {
      WorkspaceNames.add(Entry.name.slice(0, -ACTIVE_SUFFIX.length));
      continue;
    }
    if(Entry.name.endsWith(COMPLETED_SUFFIX)) {
      WorkspaceNames.add(Entry.name.slice(0, -COMPLETED_SUFFIX.length));
    }
  }

  return Array.from(WorkspaceNames).sort();
}

/**
 * @param {any} ArgReminder
 * @returns {string|null}
 */
function GetReminderId(ArgReminder) {
  return GetNonEmptyString(ArgReminder?.ReminderID) || GetNonEmptyString(ArgReminder?.reminderId);
}

/**
 * @param {any} ArgReminder
 * @returns {string|null}
 */
function ResolveCreatedOnIsoString(ArgReminder) {
  return NormalizeIsoString(ArgReminder?.CreatedOn)
    || NormalizeIsoString(ArgReminder?.createdOn)
    || NormalizeIsoString(ArgReminder?.dueDate)
    || NormalizeIsoString(ArgReminder?.ShouldPostOn)
    || NormalizeIsoString(ArgReminder?.completedAt)
    || NormalizeIsoString(ArgReminder?.completedMs);
}

/**
 * @param {any} ArgReminder
 * @param {'active'|'completed'} ArgStoreKind
 * @returns {object|null}
 */
function BuildBaselineEvent(ArgReminder, ArgStoreKind) {
  const ReminderId = GetReminderId(ArgReminder);
  if(ReminderId === null) {
    return null;
  }

  const SourceChannelId = GetNonEmptyString(ArgReminder?.OriginalChannelID)
    || GetNonEmptyString(ArgReminder?.sourceChannelID)
    || GetNonEmptyString(ArgReminder?.sourceChannelId)
    || GetNonEmptyString(ArgReminder?.TargetChannelID)
    || GetNonEmptyString(ArgReminder?.targetChannelId);

  const TargetChannelId = GetNonEmptyString(ArgReminder?.TargetChannelID)
    || GetNonEmptyString(ArgReminder?.targetChannelId)
    || GetNonEmptyString(ArgReminder?.OriginalChannelID)
    || GetNonEmptyString(ArgReminder?.sourceChannelID)
    || GetNonEmptyString(ArgReminder?.sourceChannelId);

  const DueAt = NormalizeIsoString(ArgReminder?.ShouldPostOn)
    || NormalizeIsoString(ArgReminder?.dueDate)
    || NormalizeIsoString(ArgReminder?.dueAt);

  const State = GetNonEmptyString(ArgReminder?.State)
    || GetNonEmptyString(ArgReminder?.state)
    || (ArgStoreKind === 'completed' ? 'completed' : 'scheduled');

  const AssigneeIds = GetStringArray(ArgReminder?.AssigneeIDs ?? ArgReminder?.assigneeIds);
  const AssigneeId = GetNonEmptyString(ArgReminder?.AssigneeID)
    || GetNonEmptyString(ArgReminder?.assigneeID)
    || GetNonEmptyString(ArgReminder?.assigneeId);

  const Event = {
    v: CURRENT_SCHEMA_VERSION,
    type: 'BaselineReminderImported',
    reminderId: ReminderId,
    payload: {
      text: GetNonEmptyString(ArgReminder?.ReminderMessageText)
        || GetNonEmptyString(ArgReminder?.summary)
        || GetNonEmptyString(ArgReminder?.text)
        || '',
      assigneeId: AssigneeId,
      // AssigneeIDs is the authoritative record and assigneeId only its deprecated first-entry
      // mirror, so a record written before shared assignments existed still has to produce a
      // non-lying array — otherwise the import silently undoes GH-22 for every legacy reminder.
      assigneeIds: AssigneeIds.length > 0 ? AssigneeIds : (AssigneeId ? [AssigneeId] : []),
      sourceChannelId: SourceChannelId,
      targetChannelId: TargetChannelId,
      dueAt: DueAt,
      state: State,
      githubUrls: GetStringArray(ArgReminder?.GitHubUrls ?? ArgReminder?.githubUrls),
      originalSenderId: GetNonEmptyString(ArgReminder?.OriginalSenderID)
        || GetNonEmptyString(ArgReminder?.originalSenderId),
      originalMessageId: GetNonEmptyString(ArgReminder?.OriginalMessageID)
        || GetNonEmptyString(ArgReminder?.originalMessageId),
      originalThreadTs: GetNonEmptyString(ArgReminder?.OriginalThreadTs)
        || GetNonEmptyString(ArgReminder?.originalThreadTs),
      originalChannelName: GetNonEmptyString(ArgReminder?.OriginalChannelName)
        || GetNonEmptyString(ArgReminder?.originalChannelName),
      ignoreSnooze: Boolean(ArgReminder?.IgnoreSnooze ?? ArgReminder?.ignoreSnooze),
      clientId: GetNonEmptyString(ArgReminder?.clientId) || GetNonEmptyString(ArgReminder?.ClientID),
      // Unlike a native creation, an import CAN legitimately carry `true` here: the JSON record it
      // reads may describe a thread whose relay started, or was stopped, long before the ledger
      // existed. Omitting them would let a flag-on read resume a relay a user deliberately stopped.
      gitHubRelayStarted: Boolean(ArgReminder?.GitHubRelayStarted ?? ArgReminder?.gitHubRelayStarted),
      gitHubRelayStopped: Boolean(ArgReminder?.GitHubRelayStopped ?? ArgReminder?.gitHubRelayStopped),
      // `createdOn` cannot be substituted from `ts`: ts is when the append ran, not when the
      // reminder was created, and the projection compares raw bytes against the JSON store.
      createdOn: ResolveCreatedOnIsoString(ArgReminder),
    },
  };

  const Timestamp = ResolveCreatedOnIsoString(ArgReminder);
  if(Timestamp !== null) {
    Event.ts = Timestamp;
  }

  return Event;
}

/**
 * Does the stream already carry everything a v2 fold needs for this reminder?
 *
 * Judged against the MERGED creation payloads, matching how the projection judges parity: a v1
 * event followed by an enrich event is a repaired stream, not a broken one, so re-enriching it
 * would append a line that changes nothing.
 * @param {object[]} ArgEvents Every event already in the workspace stream.
 * @returns {Map<string, boolean>} reminderId → true when no enrichment is needed.
 */
function BuildReminderCompletenessMap(ArgEvents) {
  /** @type {Map<string, Set<string>>} */
  const KeysById = new Map();
  for(const Event of ArgEvents) {
    if(!Event || typeof Event !== 'object') continue;
    if(Event.type !== 'ReminderCreated' && Event.type !== 'BaselineReminderImported') continue;
    const ReminderId = GetNonEmptyString(Event.reminderId);
    if(ReminderId === null) continue;
    const Payload = Event.payload && typeof Event.payload === 'object' ? Event.payload : {};
    let Keys = KeysById.get(ReminderId);
    if(!Keys) {
      Keys = new Set();
      KeysById.set(ReminderId, Keys);
    }
    for(const Key of Object.keys(Payload)) {
      if(Payload[Key] !== undefined) Keys.add(Key);
    }
  }

  // A baseline import can only ever be judged against the baseline requirement set — it is what this
  // script writes, and it is a superset of what a native creation needs for reconstruction.
  const Required = REQUIRED_PAYLOAD_KEYS_V2.BaselineReminderImported;
  /** @type {Map<string, boolean>} */
  const Complete = new Map();
  for(const [ReminderId, Keys] of KeysById) {
    Complete.set(ReminderId, Required.every(ArgKey => Keys.has(ArgKey)));
  }
  return Complete;
}

/**
 * @param {object[]} ArgEvents
 * @returns {Set<string>}
 */
function BuildSeededReminderIdSet(ArgEvents) {
  const SeededReminderIds = new Set();
  for(const Event of ArgEvents) {
    if(!Event || typeof Event !== 'object') continue;
    if(Event.type !== 'ReminderCreated' && Event.type !== 'BaselineReminderImported') continue;
    const ReminderId = GetNonEmptyString(Event.reminderId);
    if(ReminderId !== null) {
      SeededReminderIds.add(ReminderId);
    }
  }
  return SeededReminderIds;
}

/**
 * @param {{ workspace: string, remindersDir: string, eventsDir: string, enrich?: boolean }} ArgOptions
 *   `enrich` re-emits a v2 event for a reminder that IS already seeded but whose existing events
 *   predate the schema expansion. Without it this script can only ever seed reminders the ledger has
 *   never heard of — which means it could not repair the streams that actually need repairing.
 * @returns {Promise<{ workspace: string, baselineEvents: object[], skippedReminderIds: string[], enrichedReminderIds: string[] }>}
 */
async function CollectMissingBaselineEventsAsync(ArgOptions) {
  const Workspace = ArgOptions.workspace;
  const ActiveFilePath = path.join(ArgOptions.remindersDir, `${Workspace}${ACTIVE_SUFFIX}`);
  const CompletedFilePath = path.join(ArgOptions.remindersDir, `${Workspace}${COMPLETED_SUFFIX}`);
  const [ActiveReminders, CompletedReminders] = await Promise.all([
    ReadJsonArrayAsync(ActiveFilePath),
    ReadJsonArrayAsync(CompletedFilePath),
  ]);

  const EventStore = createEventStore({ rootDir: ArgOptions.eventsDir });
  const ExistingEvents = await EventStore.readAll(Workspace);
  const SeededReminderIds = BuildSeededReminderIdSet(ExistingEvents);
  const CompleteById = BuildReminderCompletenessMap(ExistingEvents);
  const Enrich = ArgOptions.enrich === true;

  /** @type {object[]} */
  const BaselineEvents = [];
  /** @type {string[]} */
  const SkippedReminderIds = [];
  /** @type {string[]} */
  const EnrichedReminderIds = [];

  for(const [StoreKind, Reminders] of [['active', ActiveReminders], ['completed', CompletedReminders]]) {
    for(const Reminder of Reminders) {
      const ReminderId = GetReminderId(Reminder);
      if(ReminderId === null) {
        continue;
      }
      const AlreadySeeded = SeededReminderIds.has(ReminderId);
      // Already complete, or enrichment not asked for: nothing to write. Re-emitting a complete
      // record would append a line that changes no fold, which is pure ledger noise.
      if(AlreadySeeded && (!Enrich || CompleteById.get(ReminderId) === true)) {
        SkippedReminderIds.push(ReminderId);
        continue;
      }
      const Event = BuildBaselineEvent(Reminder, /** @type {'active'|'completed'} */ (StoreKind));
      if(Event === null) {
        continue;
      }
      BaselineEvents.push(Event);
      if(AlreadySeeded) EnrichedReminderIds.push(ReminderId);
      SeededReminderIds.add(ReminderId);
      CompleteById.set(ReminderId, true);
    }
  }

  return {
    workspace: Workspace,
    baselineEvents: BaselineEvents,
    skippedReminderIds: SkippedReminderIds,
    enrichedReminderIds: EnrichedReminderIds,
  };
}

/**
 * @param {{ workspace: string, remindersDir: string, eventsDir: string, write?: boolean, enrich?: boolean }} ArgOptions
 * @returns {Promise<{ workspace: string, baselineEvents: object[], skippedReminderIds: string[], enrichedReminderIds: string[], appendedCount: number }>}
 */
async function ImportWorkspaceAsync(ArgOptions) {
  const Result = await CollectMissingBaselineEventsAsync(ArgOptions);
  let AppendedCount = 0;

  if(ArgOptions.write === true && Result.baselineEvents.length > 0) {
    const EventStore = createEventStore({ rootDir: ArgOptions.eventsDir });
    for(const Event of Result.baselineEvents) {
      const AppendResult = await EventStore.append(Result.workspace, Event);
      if(!AppendResult.ok) {
        throw AppendResult.error || new Error(`failed to append baseline event for workspace ${Result.workspace}`);
      }
      AppendedCount += 1;
    }
  }

  return {
    ...Result,
    appendedCount: AppendedCount,
  };
}

/**
 * @param {string[]} ArgArgv
 * @returns {{ repoRoot: string, workspaces: string[]|null, write: boolean, json: boolean, enrich: boolean }}
 */
function ParseArgs(ArgArgv) {
  /** @type {{ repoRoot: string, workspaces: string[]|null, write: boolean, json: boolean, enrich: boolean }} */
  const Options = {
    repoRoot: path.resolve(__dirname, '..'),
    workspaces: null,
    write: false,
    json: false,
    enrich: false,
  };

  for(let Index = 0; Index < ArgArgv.length; Index += 1) {
    const Arg = ArgArgv[Index];
    if(Arg === '--write') {
      Options.write = true;
      continue;
    }
    if(Arg === '--enrich') {
      Options.enrich = true;
      continue;
    }
    if(Arg === '--json') {
      Options.json = true;
      continue;
    }
    if(Arg === '--repo-root') {
      const Value = ArgArgv[Index + 1];
      if(!Value) {
        throw new Error('--repo-root requires a value');
      }
      Options.repoRoot = path.resolve(Value);
      Index += 1;
      continue;
    }
    if(Arg === '--workspace') {
      const Value = ArgArgv[Index + 1];
      if(!Value) {
        throw new Error('--workspace requires a value');
      }
      if(!Array.isArray(Options.workspaces)) {
        Options.workspaces = [];
      }
      Options.workspaces.push(Value);
      Index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${Arg}`);
  }

  return Options;
}

/**
 * @param {string[]} [ArgArgv]
 * @returns {Promise<object[]>}
 */
async function MainAsync(ArgArgv = process.argv.slice(2)) {
  const Options = ParseArgs(ArgArgv);
  const RemindersDir = path.join(Options.repoRoot, 'data', 'runtime', 'reminders');
  const EventsDir = path.join(Options.repoRoot, 'data', 'runtime', 'events');
  const Workspaces = Array.isArray(Options.workspaces) && Options.workspaces.length > 0
    ? Options.workspaces
    : await EnumerateWorkspaceNamesAsync(RemindersDir);

  /** @type {object[]} */
  const Results = [];
  for(const Workspace of Workspaces) {
    Results.push(await ImportWorkspaceAsync({
      workspace: Workspace,
      remindersDir: RemindersDir,
      eventsDir: EventsDir,
      write: Options.write,
      enrich: Options.enrich,
    }));
  }

  if(Options.json) {
    console.log(JSON.stringify(Results, null, 2));
  } else {
    for(const Result of Results) {
      const Mode = Options.write ? 'write' : 'dry-run';
      // Report the enrichment split explicitly. A run that says "12 events" while 12 of them are
      // re-emissions of reminders the ledger already knew reads as new coverage when it is repair.
      const Enriched = Result.enrichedReminderIds.length > 0
        ? ` — ${Result.enrichedReminderIds.length} enriching an existing reminder`
        : '';
      console.log(
        `${Result.workspace}: ${Result.baselineEvents.length} baseline event(s) ${Options.write ? 'appended' : 'planned'} (${Mode})${Enriched}`
      );
    }
  }

  return Results;
}

if (require.main === module) {
  MainAsync().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  BuildBaselineEvent,
  BuildReminderCompletenessMap,
  CollectMissingBaselineEventsAsync,
  EnumerateWorkspaceNamesAsync,
  ImportWorkspaceAsync,
  MainAsync,
  NormalizeIsoString,
};
