
// import required modules.
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const workspaces = require('./workspaces');
const SettingsModule = require('./settings-module');
const AdminAuth = require('./admin-auth');
const AdminMailer = require('./admin-mailer');
const DateUtils = require('./date-utils');
const RemindersDisplayUtils = require('./reminders-display-utils');
const SlackFormatUtils = require('./slack-format-utils');
const { ResolveClientIdentity } = require('./client-mapping');
const { createEventStore } = require('./event-store');
const { FoldReminderReadModels, ReadWithProjectionFallbackAsync } = require('./reminders-projection');

// add typedefs for our own types.
/**
 * @typedef {import('./stats-module').WorkspaceStats} WorkspaceStats
 */

/**
 * @typedef {Object} RateLimitEntry
 * @property {number} AttemptCount Number of attempts in the active window.
 * @property {number} WindowStartTimestamp Window start in milliseconds since epoch.
 */

const ValidReminderStates = new Set([
  'scheduled',
  'overdue',
  'snoozed',
  'posting',
  'posted',
  'rescheduled',
  'failed',
  'completed',
  'canceled',
  'dead-letter',
]);

const ActiveReminderStates = new Set([
  'scheduled',
  'overdue',
  'snoozed',
  'posting',
  'posted',
  'rescheduled',
  'failed',
]);

/**
 * Implements the Web API used by the Sleuth website.
 */
class WebAPI {
  /**
   * Port number to listen on for requests.
   * @type {number}
   */
  #PortNumber;

  /**
   * Bearer token that all requests should include in the Authorization header.
   * @type {string}
   */
  #BearerToken;

  /**
   * Server instance for the express app.
   * @type {import('http').Server}
   */
  #ExpressServer;

  /**
   * Express app instance.
   * @type {import('express').Express}
   */
  #ExpressApp;

  /**
  * Map of workspace names to their stats.
  * @type {Map<string, WorkspaceStats>}
  */
  #WorkspaceStatsMap;

  /**
   * Settings module instance.
   * @type {SettingsModule}
   */
  #SettingsModule;

  /**
   * Admin auth module instance.
   * @type {AdminAuth}
   */
  #AdminAuth;

  /**
   * Admin mailer instance.
   * @type {AdminMailer}
   */
  #AdminMailer;

  /**
   * Rate limiter state keyed by route + ip address.
   * @type {Map<string, RateLimitEntry>}
   */
  #RateLimitEntriesByKey = new Map();

  /**
   * Map of workspace names to their live SlackApp instances. Optional — used by the rebalance
   * export to resolve user display names and real permalinks; export falls back to raw IDs and
   * constructed archive URLs for workspaces without a running SlackApp (e.g. in tests).
   * @type {Map<string, import('./slack-app')>}
   */
  #SlackAppsByWorkspace = new Map();

  /**
   * Initialize a new instance of the WebAPI with the given port number and bearer token.
   * @param {number} ArgPortNumber Port number to listen on for requests.
   * @param {string} ArgBearerToken Bearer token that all requests should include in the Authorization header.
   * @param {Map<string, WorkspaceStats>} ArgWorkspaceStatsMap Map of workspace names to their stats.
   * @param {SettingsModule} ArgSettingsModule
   * @param {AdminAuth} ArgAdminAuth
   * @param {AdminMailer} ArgAdminMailer
   * @param {Map<string, import('./slack-app')>} [ArgSlackAppsByWorkspace] Live SlackApp per workspace.
   */
  constructor(ArgPortNumber, ArgBearerToken, ArgWorkspaceStatsMap, ArgSettingsModule, ArgAdminAuth, ArgAdminMailer, ArgSlackAppsByWorkspace) {
    // save the port number, bearer token, stats map and settings module.
    this.#PortNumber = ArgPortNumber;
    this.#BearerToken = ArgBearerToken;
    this.#WorkspaceStatsMap = ArgWorkspaceStatsMap;
    this.#SettingsModule = ArgSettingsModule;
    this.#AdminAuth = ArgAdminAuth;
    this.#AdminMailer = ArgAdminMailer;
    this.#SlackAppsByWorkspace = ArgSlackAppsByWorkspace ?? new Map();

    // create the express app and configure the middleware.
    this.#ExpressApp = express();
    this.#ExpressApp.use(express.json());
    this.#ExpressApp.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
    this.#ExpressApp.use(this.#AuthorizationMiddleware.bind(this));

    // define the API endpoints and map them to the respective handlers. NOTE: we would normally use arrow
    // functions which properly bind the 'this' context, but we are using stand-alone functions here to
    // keep the code more readable so we must bind the 'this' context manually.
    this.#ExpressApp.get('/admin/auth-status', this.#HandleGetAdminAuthStatusAsync.bind(this));
    this.#ExpressApp.post('/admin/login', this.#HandlePostAdminLoginAsync.bind(this));
    this.#ExpressApp.post('/admin/logout', this.#HandlePostAdminLogoutAsync.bind(this));
    this.#ExpressApp.post('/admin/forgot-password', this.#HandlePostAdminForgotPasswordAsync.bind(this));
    this.#ExpressApp.post('/admin/reset-password', this.#HandlePostAdminResetPasswordAsync.bind(this));
    this.#ExpressApp.post('/workspace', this.#HandlePostWorkspaceAsync.bind(this));
    this.#ExpressApp.get('/workspaces', this.#HandleGetWorkspacesAsync.bind(this));
    this.#ExpressApp.get('/workspace/:name/exists', this.#HandleGetWorkspaceExistsAsync.bind(this));
    this.#ExpressApp.get('/workspace/:name', this.#HandleGetWorkspaceAsync.bind(this));
    this.#ExpressApp.get('/workspace/:name/stats', this.#HandleGetWorkspaceStatsAsync.bind(this));
    this.#ExpressApp.get('/workspace/:name/reminders', this.#HandleGetWorkspaceRemindersAsync.bind(this));
    this.#ExpressApp.get('/admin/dashboard/workspaces', this.#HandleGetDashboardWorkspacesAsync.bind(this));
    this.#ExpressApp.get('/admin/dashboard/reminders', this.#HandleGetDashboardRemindersAsync.bind(this));
    this.#ExpressApp.delete('/workspace/:name', this.#HandleDeleteWorkspaceAsync.bind(this));
    this.#ExpressApp.post('/settings/last-file-path', this.#HandlePostLastFilePathAsync.bind(this));
    this.#ExpressApp.get('/settings/last-file-path', this.#HandleGetLastFilePathAsync.bind(this));
  }

  /**
   * Middleware to validate the Authorization header for all requests.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   * @param {import('express').NextFunction} ArgNext Next function.
   */
  #AuthorizationMiddleware(ArgReq, ArgRes, ArgNext) {
    const RequestPath = ArgReq.path;

    // check session auth for admin api routes.
    if(RequestPath.startsWith('/admin/')) {
      if(this.#IsAdminAuthExemptRoute(RequestPath)) {
        ArgNext();
        return;
      }

      const SessionToken = this.#ExtractBearerToken(ArgReq.headers['authorization']);
      if(SessionToken && this.#AdminAuth.ValidateSessionToken(SessionToken)) {
        ArgNext();
        return;
      }

      ArgRes.status(200).json({ success: false, data: 'Forbidden.' });
      return;
    }

    // check legacy bearer token for non-admin routes.
    const AuthHeader = ArgReq.headers['authorization'];
    if(AuthHeader && AuthHeader === `Bearer ${this.#BearerToken}`) {
      ArgNext();
      return;
    }

    ArgRes.status(200).json({ success: false, data: 'Forbidden.' });
  }

  /**
   * Return true when path is exempt from admin session auth.
   * @param {string} ArgRequestPath Request path.
   * @returns {boolean}
   */
  #IsAdminAuthExemptRoute(ArgRequestPath) {
    return (
      ArgRequestPath === '/admin/login' ||
      ArgRequestPath === '/admin/auth-status' ||
      ArgRequestPath === '/admin/forgot-password' ||
      ArgRequestPath === '/admin/reset-password'
    );
  }

  /**
   * Extract a bearer token from auth header.
   * @param {string|string[]|undefined} ArgAuthHeader Authorization header value.
   * @returns {string|null}
   */
  #ExtractBearerToken(ArgAuthHeader) {
    if(typeof ArgAuthHeader !== 'string') return null;
    if(!ArgAuthHeader.startsWith('Bearer ')) return null;

    const TokenValue = ArgAuthHeader.slice('Bearer '.length).trim();
    if(TokenValue.length === 0) return null;
    return TokenValue;
  }

  /**
   * Parse a boolean query-string value.
   * @param {any} ArgValue Raw query-string value.
   * @param {boolean} ArgDefaultValue Value used when the query is not present.
   * @param {string} ArgFieldName Query-string field name for error messages.
   * @returns {boolean}
   */
  #ParseBooleanQueryValue(ArgValue, ArgDefaultValue, ArgFieldName) {
    if(typeof ArgValue === 'undefined')
      return ArgDefaultValue;

    const RawValue = Array.isArray(ArgValue) ? ArgValue[0] : ArgValue;
    if(typeof RawValue !== 'string')
      throw new Error(`Invalid ${ArgFieldName} query value.`);

    const NormalizedValue = RawValue.trim().toLowerCase();
    if(NormalizedValue === 'true' || NormalizedValue === '1' || NormalizedValue === 'yes')
      return true;
    if(NormalizedValue === 'false' || NormalizedValue === '0' || NormalizedValue === 'no')
      return false;

    throw new Error(`Invalid ${ArgFieldName} query value. Use true or false.`);
  }

  /**
   * Parse the optional reminders response format.
   * @param {any} ArgValue Raw query-string value.
   * @returns {'raw'|'rebalance'}
   */
  #ParseReminderFormatQueryValue(ArgValue) {
    if(typeof ArgValue === 'undefined')
      return 'raw';

    const RawValue = Array.isArray(ArgValue) ? ArgValue[0] : ArgValue;
    if(typeof RawValue !== 'string')
      throw new Error('Invalid format query value.');

    const NormalizedValue = RawValue.trim().toLowerCase();
    if(NormalizedValue === 'raw' || NormalizedValue === 'rebalance')
      return NormalizedValue;

    throw new Error('Invalid format query value. Use raw or rebalance.');
  }

  /**
   * Parse the optional reminder state filter.
   * @param {any} ArgValue Raw query-string value.
   * @returns {string[]|null}
   */
  #ParseReminderStateQueryValue(ArgValue) {
    if(typeof ArgValue === 'undefined')
      return null;

    const RawParts = Array.isArray(ArgValue)
      ? ArgValue.flatMap(ArgCurrentValue => typeof ArgCurrentValue === 'string' ? ArgCurrentValue.split(',') : [])
      : typeof ArgValue === 'string'
        ? ArgValue.split(',')
        : [];
    const ParsedStates = /** @type {string[]} */ ([]);

    for(const CurrentPart of RawParts) {
      const NormalizedValue = CurrentPart.trim().toLowerCase();
      if(NormalizedValue.length === 0)
        continue;

      const EffectiveState = NormalizedValue === 'due' ? 'overdue' : NormalizedValue;
      if(!ValidReminderStates.has(EffectiveState))
        throw new Error(`Invalid reminder state filter: ${CurrentPart}.`);

      if(!ParsedStates.includes(EffectiveState))
        ParsedStates.push(EffectiveState);
    }

    return ParsedStates;
  }

  /**
   * Return normalized reminder state.
   * @param {any} ArgReminder Raw reminder object from disk.
   * @returns {string}
   */
  #GetReminderState(ArgReminder) {
    if(typeof ArgReminder?.State !== 'string')
      return 'scheduled';

    const RawState = ArgReminder.State.trim().toLowerCase();
    if(RawState === 'due')
      return 'overdue';
    if(ValidReminderStates.has(RawState))
      return RawState;

    return 'scheduled';
  }

  /**
   * Return true when reminder state is still active.
   * @param {string} ArgState Normalized reminder state.
   * @returns {boolean}
   */
  #IsReminderStateActive(ArgState) {
    return ActiveReminderStates.has(ArgState);
  }

  /**
   * Normalize a persisted reminder timestamp for external responses.
   * @param {any} ArgValue Persisted reminder date value.
   * @returns {string|null}
   */
  #NormalizeReminderDateValue(ArgValue) {
    if(ArgValue instanceof Date)
      return ArgValue.toISOString();

    if(typeof ArgValue === 'string') {
      const ParsedDate = new Date(ArgValue);
      if(Number.isNaN(ParsedDate.getTime()))
        return ArgValue;

      return ParsedDate.toISOString();
    }

    return null;
  }

  /**
   * Read a workspace reminders file from disk.
   * @param {string} ArgWorkspaceName Workspace name.
   * @param {'REMINDERS_READ_SOURCE'|'REBALANCE_EXPORT_SOURCE'} [ArgFlagName] Independent source flag.
   * @returns {Promise<{ Reminders: any[], RemindersFilePath: string }>}
   */
  async #ReadWorkspaceRemindersAsync(ArgWorkspaceName, ArgFlagName = 'REMINDERS_READ_SOURCE') {
    const RemindersFilePath = path.join(__dirname, '..', 'data', 'runtime', 'reminders', `${ArgWorkspaceName}_reminders.json`);
    const ReadAuthoritativeAsync = async () => {
      try {
        const RawJSON = await fs.readFile(RemindersFilePath, 'utf8');
        const ParsedJSON = JSON.parse(RawJSON);
        if(!Array.isArray(ParsedJSON))
          throw new Error('Reminders file is malformed. Expected a JSON array.');
        return ParsedJSON;
      } catch(error) {
        if(error.code === 'ENOENT') return [];
        throw error;
      }
    };
    const Result = await ReadWithProjectionFallbackAsync({
      flagName: ArgFlagName,
      Logger: console,
      ReadAuthoritativeAsync,
      ReadProjectionAsync: async () => (await this.#ReadWorkspaceProjectionAsync(ArgWorkspaceName)).reminders,
    });
    return { Reminders: Result.value, RemindersFilePath };
  }

  /**
   * Fold a workspace's event ledger for the Phase 5 read flags.  An absent or
   * incomplete log is an error on purpose: ReadWithProjectionFallbackAsync then
   * serves the JSON store instead of an unsafe empty projection.
   * @param {string} ArgWorkspaceName Workspace name.
   * @returns {Promise<{ reminders: any[], completed: any[] }>}
   */
  async #ReadWorkspaceProjectionAsync(ArgWorkspaceName) {
    const EventsRootPath = path.join(__dirname, '..', 'data', 'runtime', 'events');
    const SafeWorkspaceName = String(ArgWorkspaceName).replace(/[^A-Za-z0-9._-]/g, '_');
    const EventsFilePath = path.join(EventsRootPath, `${SafeWorkspaceName}_events.jsonl`);
    await fs.access(EventsFilePath);
    const EventStore = createEventStore({ rootDir: EventsRootPath });
    const Events = await EventStore.readAll(ArgWorkspaceName);
    if(Events.length === 0) throw new Error('event ledger is empty');
    return FoldReminderReadModels(Events, { strict: true });
  }

  /**
   * Read a workspace completed-reminders history file from disk. Mirrors
   * #ReadWorkspaceRemindersAsync: a missing file (the normal case for a workspace with no
   * completions yet) degrades to an empty array rather than throwing.
   * @param {string} ArgWorkspaceName Workspace name.
   * @returns {Promise<any[]>}
   */
  async #ReadWorkspaceCompletedAsync(ArgWorkspaceName) {
    const CompletedFilePath = path.join(__dirname, '..', 'data', 'runtime', 'reminders', `${ArgWorkspaceName}_completed.json`);

    const Result = await ReadWithProjectionFallbackAsync({
      flagName: 'COMPLETED_READ_SOURCE',
      Logger: console,
      ReadAuthoritativeAsync: async () => {
        try {
          const RawJSON = await fs.readFile(CompletedFilePath, 'utf8');
          const ParsedJSON = JSON.parse(RawJSON);
          return Array.isArray(ParsedJSON) ? ParsedJSON : [];
        } catch(error) {
          if(error.code === 'ENOENT') return [];
          throw error;
        }
      },
      ReadProjectionAsync: async () => (await this.#ReadWorkspaceProjectionAsync(ArgWorkspaceName)).completed,
    });
    return Result.value;
  }

  /**
   * Filter reminder records using request query options.
   * @param {any[]} ArgReminders Raw reminder records.
   * @param {boolean} ArgActiveOnly Restrict response to active reminder states.
   * @param {string[]|null} ArgStateFilter Optional normalized state filter.
   * @returns {any[]}
   */
  #FilterReminderRecords(ArgReminders, ArgActiveOnly, ArgStateFilter) {
    return ArgReminders.filter(ArgReminder => {
      const ReminderState = this.#GetReminderState(ArgReminder);

      if(ArgActiveOnly && !this.#IsReminderStateActive(ReminderState))
        return false;

      if(Array.isArray(ArgStateFilter) && !ArgStateFilter.includes(ReminderState))
        return false;

      return true;
    });
  }

  /**
   * Build a rebalance-friendly reminder record.
   * @param {any} ArgReminder Raw reminder object from disk.
   * @returns {object}
   */
  #BuildRebalanceReminderRecord(ArgReminder) {
    const ReminderState = this.#GetReminderState(ArgReminder);
    const GitHubUrls = Array.isArray(ArgReminder?.GitHubUrls)
      ? ArgReminder.GitHubUrls.filter((/** @type {any} */ ArgUrl) => typeof ArgUrl === 'string')
      : [];

    return {
      reminderId: typeof ArgReminder?.ReminderID === 'string' ? ArgReminder.ReminderID : null,
      state: ReminderState,
      isActive: this.#IsReminderStateActive(ReminderState),
      createdOn: this.#NormalizeReminderDateValue(ArgReminder?.CreatedOn),
      shouldPostOn: this.#NormalizeReminderDateValue(ArgReminder?.ShouldPostOn),
      reminderMessageText: typeof ArgReminder?.ReminderMessageText === 'string' ? ArgReminder.ReminderMessageText : '',
      ignoreSnooze: Boolean(ArgReminder?.IgnoreSnooze),
      assigneeId: typeof ArgReminder?.AssigneeID === 'string' && ArgReminder.AssigneeID.length > 0 ? ArgReminder.AssigneeID : null,
      originalSenderId: typeof ArgReminder?.OriginalSenderID === 'string' ? ArgReminder.OriginalSenderID : null,
      targetChannelId: typeof ArgReminder?.TargetChannelID === 'string' ? ArgReminder.TargetChannelID : null,
      originalChannelId: typeof ArgReminder?.OriginalChannelID === 'string' ? ArgReminder.OriginalChannelID : null,
      originalChannelName: typeof ArgReminder?.OriginalChannelName === 'string' ? ArgReminder.OriginalChannelName : null,
      originalMessageId: typeof ArgReminder?.OriginalMessageID === 'string' ? ArgReminder.OriginalMessageID : null,
      originalThreadTs: typeof ArgReminder?.OriginalThreadTs === 'string' ? ArgReminder.OriginalThreadTs : null,
      githubUrls: GitHubUrls,
      clientId: this.#ResolveExportClientId(ArgReminder),
    };
  }

  /**
   * Client slug for an export record. Prefers the value stamped on the reminder at creation
   * (GH-361); falls back to resolving it from the channel/repo mapping so reminders created
   * before stamping still carry a client — the same read-time resolution reminders-module does,
   * so the export matches what Slack Q&A sees. Null when no client matches.
   * @param {any} ArgReminder Raw reminder object from disk.
   * @returns {string|null}
   */
  #ResolveExportClientId(ArgReminder) {
    if(typeof ArgReminder?.clientId === 'string' && ArgReminder.clientId.length > 0)
      return ArgReminder.clientId;
    try {
      return ResolveClientIdentity(ArgReminder).ClientID;
    } catch {
      return null; // malformed mapping file → no client, never throw the export
    }
  }

  /**
   * Resolve a user display name through the workspace's live SlackApp, memoizing per export
   * build. Returns null when no SlackApp is available or the lookup fails.
   * @param {import('./slack-app')|null} ArgSlackApp Live SlackApp for the workspace, if any.
   * @param {Map<string, string|null>} ArgNameCache Per-build memo of userId → display name.
   * @param {string|null} ArgUserId User ID to resolve.
   * @returns {Promise<string|null>}
   */
  async #ResolveUserDisplayNameAsync(ArgSlackApp, ArgNameCache, ArgUserId) {
    if(!ArgUserId || !ArgSlackApp) return null;
    if(ArgNameCache.has(ArgUserId)) return ArgNameCache.get(ArgUserId) ?? null;
    let Name = null;
    try { Name = await ArgSlackApp.GetUserDisplayNameAsync(ArgUserId); } catch { /* fall back to raw ID */ }
    ArgNameCache.set(ArgUserId, Name);
    return Name;
  }

  /**
   * Build a rebalance-friendly reminder export payload. Reminders are returned in the SAME
   * presentation order as the Slack `show reminders` digest — bucketed by due date (Due Today /
   * Due after today / Due within last 7 days / Due older than 7 days, in the workspace time
   * zone), chronological within each bucket — and each record carries a pre-rendered `display`
   * block (section, global A/B/C label, extracted summary, permalink, assignee name, age) so
   * consumers like the rebalance-OS dashboard can render exactly what Slack users see without
   * duplicating the wording/sorting rules.
   * @param {string} ArgWorkspaceName Workspace name.
   * @param {any[]} ArgFilteredReminders Filtered reminder records.
   * @param {number} ArgTotalReminderCount Total reminder count before filters.
   * @param {boolean} ArgActiveOnly Restrict response to active reminder states.
   * @param {string[]|null} ArgStateFilter Optional normalized state filter.
   * @param {string} ArgRemindersFilePath Absolute reminders file path.
   * @param {string} ArgTimeZone Workspace IANA time zone for bucketing and ages.
   * @param {import('./slack-app')|null} ArgSlackApp Live SlackApp (names/permalinks) or null.
   * @returns {Promise<object>}
   */
  async #BuildRebalanceReminderExportAsync(ArgWorkspaceName, ArgFilteredReminders, ArgTotalReminderCount, ArgActiveOnly, ArgStateFilter, ArgRemindersFilePath, ArgTimeZone, ArgSlackApp) {
    const RelativeSourcePath = path.join('data', 'runtime', 'reminders', path.basename(ArgRemindersFilePath)).replace(/\\/g, '/');

    // bucket exactly like the Slack digest: BucketRemindersByDueDate works on Date-valued
    // ShouldPostOn, so wrap each record with a parsed due date (undated → epoch 0 → oldest bucket).
    const Bucketable = ArgFilteredReminders.map(ArgReminder => {
      const Record = /** @type {any} */ (this.#BuildRebalanceReminderRecord(ArgReminder));
      const DueMs = Date.parse(Record.shouldPostOn ?? '');
      return { Record, ShouldPostOn: new Date(Number.isFinite(DueMs) ? DueMs : 0) };
    });
    const Buckets = RemindersDisplayUtils.BucketRemindersByDueDate(Bucketable, ArgTimeZone);

    const NowInTimeZone = DateUtils.GetCurrentDateInTimeZone(ArgTimeZone);
    const NameCache = new Map();
    const OrderedReminders = [];
    let Counter = 1;

    for(const Section of RemindersDisplayUtils.REMINDER_DUE_SECTIONS) {
      const InSection = [...Buckets[Section.key]].sort(
        (ArgLeft, ArgRight) => ArgLeft.ShouldPostOn.getTime() - ArgRight.ShouldPostOn.getTime()
      );

      for(const Item of InSection) {
        const Record = Item.Record;
        const SlackSummary = RemindersDisplayUtils.ExtractCompactSummary(Record.reminderMessageText);

        // resolve display names for the tagged user and any user mentions inside the summary.
        // GH-429: use the canonical mention-extraction grammar (SlackFormatUtils.ExtractUserMentions)
        // instead of a locally re-derived regex, so this stays in sync with the other extraction/
        // substitution call sites (slack-message-pipeline.js) rather than drifting independently.
        const TaggedUserId = Record.assigneeId || Record.originalSenderId || null;
        const MentionedIds = SlackFormatUtils.ExtractUserMentions(SlackSummary);
        /** @type {Record<string, string>} */
        const NamesById = {};
        for(const UserId of new Set([TaggedUserId, ...MentionedIds].filter(Boolean))) {
          const Name = await this.#ResolveUserDisplayNameAsync(ArgSlackApp, NameCache, UserId);
          if(Name) NamesById[UserId] = Name;
        }

        // real permalink when a live SlackApp is available; deterministic archive URL otherwise
        // (same construction as the memories export's threadUrl).
        let Permalink = null;
        if(ArgSlackApp && Record.originalChannelId && Record.originalMessageId)
          Permalink = await ArgSlackApp.GetPermaLinkAsync(Record.originalChannelId, Record.originalMessageId);
        if(!Permalink && Record.originalChannelId && Record.originalMessageId)
          Permalink = `https://${ArgWorkspaceName}.slack.com/archives/${Record.originalChannelId}/p${Record.originalMessageId.replace('.', '')}`;

        const CreatedMs = Date.parse(Record.createdOn ?? '');
        const AgeDays = Number.isFinite(CreatedMs)
          ? Math.floor((NowInTimeZone.getTime() - CreatedMs) / (24 * 60 * 60 * 1000))
          : 0;

        OrderedReminders.push({
          ...Record,
          display: {
            label: RemindersDisplayUtils.GetAlphabeticalLabel(Counter),
            sectionKey: Section.key,
            sectionLabel: Section.label.replace(/\*/g, ''),
            summary: RemindersDisplayUtils.ToWebSafeSummary(SlackSummary, NamesById),
            slackSummary: SlackSummary,
            permalink: Permalink,
            taggedUserId: TaggedUserId,
            assigneeName: (TaggedUserId && NamesById[TaggedUserId]) || null,
            ageDays: AgeDays,
          },
        });
        Counter++;
      }
    }

    return {
      workspaceName: ArgWorkspaceName,
      fetchedAt: new Date().toISOString(),
      totalReminderCount: ArgTotalReminderCount,
      returnedReminderCount: OrderedReminders.length,
      filters: {
        activeOnly: ArgActiveOnly,
        states: ArgStateFilter ?? [],
      },
      source: {
        type: 'sleuth-reminders-file',
        relativePath: RelativeSourcePath,
      },
      display: {
        timeZone: ArgTimeZone,
        sectionOrder: RemindersDisplayUtils.REMINDER_DUE_SECTIONS.map(
          Section => ({ key: Section.key, label: Section.label.replace(/\*/g, '') })
        ),
      },
      reminders: OrderedReminders
    };
  }

  /**
   * Check route-specific rate limit for an ip address.
   * @param {import('express').Request} ArgReq Request object.
   * @param {string} ArgRouteKey Route key name.
   * @param {number} ArgMaxAttempts Max attempts per window.
   * @param {number} ArgWindowMs Window duration in milliseconds.
   * @returns {boolean}
   */
  #IsRouteRateLimited(ArgReq, ArgRouteKey, ArgMaxAttempts, ArgWindowMs) {
    const IpAddress = ArgReq.ip || ArgReq.socket?.remoteAddress || 'unknown';
    const RateLimitKey = `${ArgRouteKey}:${IpAddress}`;
    const CurrentTimestamp = Date.now();

    const ExistingEntry = this.#RateLimitEntriesByKey.get(RateLimitKey);
    if(!ExistingEntry || CurrentTimestamp - ExistingEntry.WindowStartTimestamp >= ArgWindowMs) {
      this.#RateLimitEntriesByKey.set(RateLimitKey, {
        AttemptCount: 1,
        WindowStartTimestamp: CurrentTimestamp
      });
      return false;
    }

    if(ExistingEntry.AttemptCount >= ArgMaxAttempts)
      return true;

    ExistingEntry.AttemptCount += 1;
    return false;
  }

  /**
   * Build an absolute reset-password link.
   * @param {import('express').Request} ArgReq Request object.
   * @param {string} ArgResetToken Password-reset token.
   * @returns {Promise<string>}
   */
  async #BuildPasswordResetLinkAsync(ArgReq, ArgResetToken) {
    const ConfiguredBaseUrl = await this.#AdminAuth.GetAdminBaseUrlAsync();
    let BaseUrl = ConfiguredBaseUrl;
    if(BaseUrl.length === 0)
      BaseUrl = `${ArgReq.protocol}://${ArgReq.get('host')}`;

    BaseUrl = BaseUrl.replace(/\/+$/, '');
    const EncodedToken = encodeURIComponent(ArgResetToken);
    return `${BaseUrl}/admin/reset-password.html?token=${EncodedToken}`;
  }

  /**
   * Build password-reset email html.
   * @param {string} ArgResetLink Reset link URL.
   * @returns {string}
   */
  #BuildPasswordResetEmailHtml(ArgResetLink) {
    return [
      '<p>You requested a password reset for the Sleuth admin panel.</p>',
      `<p><a href="${ArgResetLink}">Reset your password</a></p>`,
      '<p>This link expires in 15 minutes and can only be used once.</p>'
    ].join('\n');
  }

  /**
   * Handle GET /admin/auth-status request.
   * @param {import('express').Request} _ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetAdminAuthStatusAsync(_ArgReq, ArgRes) {
    try {
      const IsConfigured = await this.#AdminAuth.IsConfiguredAsync();
      ArgRes.status(200).json({ success: true, data: { configured: IsConfigured } });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle POST /admin/login request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandlePostAdminLoginAsync(ArgReq, ArgRes) {
    try {
      const IsRateLimited = this.#IsRouteRateLimited(ArgReq, 'admin-login', 5, 15 * 60 * 1000);
      if(IsRateLimited) {
        ArgRes.status(200).json({ success: false, data: 'Too many attempts. Try again later.' });
        return;
      }

      const EmailValue = ArgReq.body?.email;
      const PasswordValue = ArgReq.body?.password;
      if(typeof EmailValue !== 'string' || typeof PasswordValue !== 'string') {
        ArgRes.status(200).json({ success: false, data: 'Invalid credentials.' });
        return;
      }

      const IsConfigured = await this.#AdminAuth.IsConfiguredAsync();
      if(!IsConfigured) {
        ArgRes.status(200).json({ success: false, data: 'Admin auth not configured. Run npm run admin:setup.' });
        return;
      }

      const IsValid = await this.#AdminAuth.ValidateCredentialsAsync(EmailValue, PasswordValue);
      if(!IsValid) {
        ArgRes.status(200).json({ success: false, data: 'Invalid credentials.' });
        return;
      }

      const SessionToken = this.#AdminAuth.CreateSessionToken();
      ArgRes.status(200).json({
        success: true,
        data: {
          token: SessionToken,
          expiresInSeconds: 8 * 60 * 60
        }
      });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle POST /admin/logout request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandlePostAdminLogoutAsync(ArgReq, ArgRes) {
    try {
      const SessionToken = this.#ExtractBearerToken(ArgReq.headers['authorization']);
      if(SessionToken)
        this.#AdminAuth.InvalidateSessionToken(SessionToken);

      ArgRes.status(200).json({ success: true, data: 'Logged out.' });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle POST /admin/forgot-password request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandlePostAdminForgotPasswordAsync(ArgReq, ArgRes) {
    const GenericMessage = 'If the account exists, a reset email has been sent.';

    try {
      const IsRateLimited = this.#IsRouteRateLimited(ArgReq, 'admin-forgot-password', 3, 15 * 60 * 1000);
      if(IsRateLimited) {
        ArgRes.status(200).json({ success: false, data: 'Too many attempts. Try again later.' });
        return;
      }

      const EmailValue = typeof ArgReq.body?.email === 'string' ? ArgReq.body.email : '';
      const IsConfigured = await this.#AdminAuth.IsConfiguredAsync();
      if(!IsConfigured) {
        ArgRes.status(200).json({ success: true, data: GenericMessage });
        return;
      }

      const IsAdminEmail = await this.#AdminAuth.DoesEmailMatchConfiguredAdminAsync(EmailValue);
      if(!IsAdminEmail) {
        ArgRes.status(200).json({ success: true, data: GenericMessage });
        return;
      }

      const ResetToken = this.#AdminAuth.CreatePasswordResetToken();
      const ResetLink = await this.#BuildPasswordResetLinkAsync(ArgReq, ResetToken);
      const AdminEmail = await this.#AdminAuth.GetAdminEmailAsync();
      const EmailHtmlBody = this.#BuildPasswordResetEmailHtml(ResetLink);
      await this.#AdminMailer.SendEmailAsync(AdminEmail, 'Sleuth admin password reset', EmailHtmlBody);

      ArgRes.status(200).json({ success: true, data: GenericMessage });
    } catch(error) {
      console.error('Error in admin forgot-password handler:', error.message);
      ArgRes.status(200).json({ success: true, data: GenericMessage });
    }
  }

  /**
   * Handle POST /admin/reset-password request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandlePostAdminResetPasswordAsync(ArgReq, ArgRes) {
    try {
      const TokenValue = typeof ArgReq.body?.token === 'string' ? ArgReq.body.token.trim() : '';
      const NewPasswordValue = typeof ArgReq.body?.newPassword === 'string' ? ArgReq.body.newPassword : '';
      if(TokenValue.length === 0 || NewPasswordValue.length < 8) {
        ArgRes.status(200).json({ success: false, data: 'Invalid token or password.' });
        return;
      }

      const IsValidResetToken = this.#AdminAuth.ConsumePasswordResetToken(TokenValue);
      if(!IsValidResetToken) {
        ArgRes.status(200).json({ success: false, data: 'Invalid or expired reset token.' });
        return;
      }

      await this.#AdminAuth.SetPasswordAsync(NewPasswordValue);
      ArgRes.status(200).json({ success: true, data: 'Password reset successful.' });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle POST /workspace request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandlePostWorkspaceAsync(ArgReq, ArgRes) {
    // save the workspace info and return a success or failure response. NOTE: if the workspace already exists
    // then it will be overwritten with the new information. The request body should contain the workspace
    // information in JSON format and the save function will validate the data before saving it.
    try {
      await workspaces.SaveWorkspaceInfoAsync(ArgReq.body);
      ArgRes.status(200).json({ success: true, data: 'Workspace saved.' });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /workspaces request.
   * @param {import('express').Request} _ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetWorkspacesAsync(_ArgReq, ArgRes) {
    // retrieve the list of workspace names and return a success or failure response.
    try {
      const WorkspaceNames = await workspaces.EnumerateWorkspaceNamesAsync();
      ArgRes.status(200).json({ success: true, data: WorkspaceNames });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /workspace/:name/exists request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetWorkspaceExistsAsync(ArgReq, ArgRes) {
    // check if the given workspace exists and return a success or failure response.
    try {
      const WorkspaceExists = await workspaces.WorkspaceExistsAsync(ArgReq.params.name);
      ArgRes.status(200).json({ success: true, data: WorkspaceExists });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /workspace/:name request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetWorkspaceAsync(ArgReq, ArgRes) {
    // retrieve the workspace information and return a success or failure response.
    try {
      const TargetWorkspaceInfo = await workspaces.LoadWorkspaceInfoByNameAsync(ArgReq.params.name);
      ArgRes.status(200).json({ success: true, data: TargetWorkspaceInfo });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /workspace/:name/stats request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetWorkspaceStatsAsync(ArgReq, ArgRes) {
    try {
      // verify the workspace exists first. NOTE: this is necessary because the stats are stored in a separate
      // map and it is not dynamically updated when workspaces are added or removed.
      const WorkspaceExists = await workspaces.WorkspaceExistsAsync(ArgReq.params.name);
      if (!WorkspaceExists) throw new Error('Workspace not found.');

      // get stats for the workspace.
      const TargetStats = this.#WorkspaceStatsMap.get(ArgReq.params.name);
      if (!TargetStats) throw new Error('Stats not found for workspace.');

      // return the workspace stats.
      ArgRes.status(200).json({ success: true, data: TargetStats });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /workspace/:name/reminders request. Reads reminders from disk.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetWorkspaceRemindersAsync(ArgReq, ArgRes) {
    try {
      const WorkspaceName = ArgReq.params.name;
      const ResponseFormat = this.#ParseReminderFormatQueryValue(ArgReq.query.format);
      const ActiveOnly = this.#ParseBooleanQueryValue(ArgReq.query.activeOnly, false, 'activeOnly');
      const StateFilter = this.#ParseReminderStateQueryValue(ArgReq.query.state);

      // verify the workspace exists before attempting to read reminders.
      const WorkspaceExists = await workspaces.WorkspaceExistsAsync(WorkspaceName);
      if(!WorkspaceExists) throw new Error('Workspace not found.');

      const SourceFlag = ResponseFormat === 'rebalance' ? 'REBALANCE_EXPORT_SOURCE' : 'REMINDERS_READ_SOURCE';
      const { Reminders, RemindersFilePath } = await this.#ReadWorkspaceRemindersAsync(WorkspaceName, SourceFlag);
      const FilteredReminders = this.#FilterReminderRecords(Reminders, ActiveOnly, StateFilter);
      if(ResponseFormat === 'rebalance') {
        let WorkspaceTimeZone = 'UTC';
        try {
          const TargetWorkspaceInfo = await workspaces.LoadWorkspaceInfoByNameAsync(WorkspaceName);
          WorkspaceTimeZone = TargetWorkspaceInfo?.MAIN_TIMEZONE || 'UTC';
        } catch { /* keep UTC for workspaces with unreadable config */ }

        const ExportData = await this.#BuildRebalanceReminderExportAsync(
          WorkspaceName,
          FilteredReminders,
          Reminders.length,
          ActiveOnly,
          StateFilter,
          RemindersFilePath,
          WorkspaceTimeZone,
          this.#SlackAppsByWorkspace.get(WorkspaceName) ?? null
        );
        ArgRes.status(200).json({ success: true, data: ExportData });
        return;
      }

      ArgRes.status(200).json({ success: true, data: FilteredReminders });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /admin/dashboard/workspaces request. Returns the list of workspace names so the
   * read-only reminders dashboard can populate its workspace selector. Admin-session protected
   * (non-exempt /admin/* route).
   * @param {import('express').Request} _ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetDashboardWorkspacesAsync(_ArgReq, ArgRes) {
    try {
      const WorkspaceNames = await workspaces.EnumerateWorkspaceNamesAsync();
      ArgRes.status(200).json({ success: true, data: WorkspaceNames });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /admin/dashboard/reminders?workspace=NAME request. Builds a flat, display-ready
   * payload for the read-only reminders dashboard: task name, assignee, assignor, due date and
   * completed date per reminder. Admin-session protected (non-exempt /admin/* route).
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetDashboardRemindersAsync(ArgReq, ArgRes) {
    try {
      const WorkspaceName = typeof ArgReq.query.workspace === 'string' ? ArgReq.query.workspace : '';
      if(!WorkspaceName)
        throw new Error('A workspace query parameter is required.');

      const WorkspaceExists = await workspaces.WorkspaceExistsAsync(WorkspaceName);
      if(!WorkspaceExists)
        throw new Error('Workspace not found.');

      const { Reminders } = await this.#ReadWorkspaceRemindersAsync(WorkspaceName);
      const CompletedRecords = await this.#ReadWorkspaceCompletedAsync(WorkspaceName);

      const ExportData = await this.#BuildDashboardReminderExportAsync(
        WorkspaceName,
        Reminders,
        CompletedRecords,
        this.#SlackAppsByWorkspace.get(WorkspaceName) ?? null
      );
      ArgRes.status(200).json({ success: true, data: ExportData });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Build the read-only dashboard payload. Each reminder becomes a flat record with a
   * human-readable task name (extracted the same way the Slack digest does), resolved assignee
   * and assignor display names, its due date (ShouldPostOn) and — when the reminder has been
   * completed — its completed date pulled from the workspace completion history. Reminders that
   * exist only in the completion history (already removed from the active file) are folded in so
   * finished tasks still appear. A single NameCache is shared across the whole build so each
   * Slack user is resolved at most once.
   * @param {string} ArgWorkspaceName Workspace name.
   * @param {any[]} ArgReminders Raw active reminder records from disk.
   * @param {any[]} ArgCompletedRecords Raw completion history records from disk.
   * @param {import('./slack-app')|null} ArgSlackApp Live SlackApp (names/permalinks) or null.
   * @returns {Promise<object>}
   */
  async #BuildDashboardReminderExportAsync(ArgWorkspaceName, ArgReminders, ArgCompletedRecords, ArgSlackApp) {
    // index completion history by reminder id; a reminder may have multiple completion rows over
    // time, so keep the most recent completion timestamp.
    const CompletedMsById = new Map();
    for(const Record of ArgCompletedRecords) {
      const ReminderId = typeof Record?.reminderId === 'string' ? Record.reminderId : null;
      const CompletedMs = typeof Record?.completedMs === 'number' ? Record.completedMs : null;
      if(!ReminderId || CompletedMs === null)
        continue;
      const Existing = CompletedMsById.get(ReminderId);
      if(Existing === undefined || CompletedMs > Existing)
        CompletedMsById.set(ReminderId, CompletedMs);
    }

    const NameCache = new Map();
    const SeenReminderIds = new Set();
    const Rows = [];

    for(const RawReminder of ArgReminders) {
      const Record = /** @type {any} */ (this.#BuildRebalanceReminderRecord(RawReminder));
      if(Record.reminderId)
        SeenReminderIds.add(Record.reminderId);

      const Summary = RemindersDisplayUtils.ExtractCompactSummary(Record.reminderMessageText);
      const AssigneeId = Record.assigneeId || Record.originalSenderId || null;
      const AssignorId = Record.originalSenderId || null;

      // resolve display names for the assignee, assignor and any users @-mentioned in the summary.
      // GH-432: canonical mention-extraction grammar (SlackFormatUtils.ExtractUserMentions) instead
      // of a locally re-derived regex.
      const MentionedIds = SlackFormatUtils.ExtractUserMentions(Summary);
      /** @type {Record<string, string>} */
      const NamesById = {};
      for(const UserId of new Set([AssigneeId, AssignorId, ...MentionedIds].filter(Boolean))) {
        const Name = await this.#ResolveUserDisplayNameAsync(ArgSlackApp, NameCache, UserId);
        if(Name) NamesById[UserId] = Name;
      }

      const CompletedMs = Record.reminderId ? CompletedMsById.get(Record.reminderId) : undefined;

      Rows.push({
        reminderId: Record.reminderId,
        taskName: RemindersDisplayUtils.ToWebSafeSummary(Summary, NamesById),
        assigneeId: AssigneeId,
        assigneeName: AssigneeId ? (NamesById[AssigneeId] || AssigneeId) : null,
        assignorId: AssignorId,
        assignorName: AssignorId ? (NamesById[AssignorId] || AssignorId) : null,
        createdOn: Record.createdOn,
        dueDate: Record.shouldPostOn,
        completedDate: CompletedMs !== undefined ? new Date(CompletedMs).toISOString() : null,
        state: CompletedMs !== undefined ? 'completed' : Record.state,
        permalink: this.#BuildReminderArchivePermalink(ArgWorkspaceName, Record.originalChannelId, Record.originalMessageId),
      });
    }

    // fold in completion-history rows for reminders no longer present in the active file so
    // finished tasks still show up on the dashboard.
    for(const Record of ArgCompletedRecords) {
      const ReminderId = typeof Record?.reminderId === 'string' ? Record.reminderId : null;
      if(!ReminderId || SeenReminderIds.has(ReminderId))
        continue;
      SeenReminderIds.add(ReminderId);

      const AssigneeId = typeof Record?.assigneeID === 'string' && Record.assigneeID.length > 0 ? Record.assigneeID : null;
      /** @type {Record<string, string>} */
      const NamesById = {};
      if(AssigneeId) {
        const Name = await this.#ResolveUserDisplayNameAsync(ArgSlackApp, NameCache, AssigneeId);
        if(Name) NamesById[AssigneeId] = Name;
      }
      const CompletedMs = typeof Record?.completedMs === 'number' ? Record.completedMs : null;

      Rows.push({
        reminderId: ReminderId,
        taskName: RemindersDisplayUtils.ToWebSafeSummary(
          RemindersDisplayUtils.ExtractCompactSummary(Record?.summary ?? ''),
          NamesById
        ),
        assigneeId: AssigneeId,
        assigneeName: AssigneeId ? (NamesById[AssigneeId] || AssigneeId) : null,
        assignorId: null,
        assignorName: null,
        createdOn: null,
        dueDate: this.#NormalizeReminderDateValue(Record?.dueDate),
        completedDate: CompletedMs !== null ? new Date(CompletedMs).toISOString() : null,
        state: 'completed',
        permalink: this.#BuildReminderArchivePermalink(ArgWorkspaceName, Record?.sourceChannelID ?? null, null),
      });
    }

    return {
      workspaceName: ArgWorkspaceName,
      fetchedAt: new Date().toISOString(),
      reminderCount: Rows.length,
      reminders: Rows,
    };
  }

  /**
   * Build a best-effort Slack archive permalink for a reminder's originating message. Returns
   * null when the channel or message id is unavailable. Same URL construction as the rebalance
   * export's fallback permalink.
   * @param {string} ArgWorkspaceName Workspace name (Slack subdomain).
   * @param {string|null} ArgChannelId Originating channel id.
   * @param {string|null} ArgMessageId Originating message ts.
   * @returns {string|null}
   */
  #BuildReminderArchivePermalink(ArgWorkspaceName, ArgChannelId, ArgMessageId) {
    if(!ArgChannelId || !ArgMessageId)
      return null;
    return `https://${ArgWorkspaceName}.slack.com/archives/${ArgChannelId}/p${ArgMessageId.replace('.', '')}`;
  }

  /**
   * Handle DELETE /workspace/:name request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleDeleteWorkspaceAsync(ArgReq, ArgRes) {
    // delete the given workspace and return a success or failure response. NOTE: if the workspace
    // does not exist, an error will be thrown and a failure response will be returned.
    try {
      await workspaces.DeleteWorkspaceAsync(ArgReq.params.name);
      ArgRes.status(200).json({ success: true, data: 'Workspace deleted.' });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle POST /settings/last-file-path request.
   * @param {import('express').Request} ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandlePostLastFilePathAsync(ArgReq, ArgRes) {
    try {
      const PathValue = ArgReq.body.path;
      if(typeof PathValue !== 'string' || PathValue.length === 0)
        throw new Error('Invalid path.');

      await this.#SettingsModule.SetLastManualFilePathAsync(PathValue);
      ArgRes.status(200).json({ success: true, data: 'Path saved.' });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Handle GET /settings/last-file-path request.
   * @param {import('express').Request} _ArgReq Request object.
   * @param {import('express').Response} ArgRes Response object.
   */
  async #HandleGetLastFilePathAsync(_ArgReq, ArgRes) {
    try {
      const Value = this.#SettingsModule.GetLastManualFilePath();
      ArgRes.status(200).json({ success: true, data: Value });
    } catch(error) {
      ArgRes.status(200).json({ success: false, data: `Error: ${error.message}` });
    }
  }

  /**
   * Start the Web API server.
   * @returns {Promise<void>}
   */
  async StartAsync() {
    // start the express server and return a promise that resolves when the server is listening.
    return new Promise((ArgResolve, ArgReject) => {
      this.#ExpressServer = this.#ExpressApp.listen(this.#PortNumber, ArgError => {
        if(ArgError) {
          ArgReject(ArgError);
          return;
        }

        const BoundAddress = this.#ExpressServer.address();
        if(BoundAddress && typeof BoundAddress !== 'string')
          this.#PortNumber = BoundAddress.port;

        ArgResolve();
      });
    });
  }

  /**
   * Stop the Web API server.
   * @returns {Promise<void>}
   */
  async StopAsync() {
    // stop the express server and return a promise that resolves when the server is closed.
    return new Promise((ArgResolve) => {
      // if the server hasn't been started, then resolve and exit early.
      if(!this.#ExpressServer) {
        ArgResolve();
        return;
      }

      // try to close the server gracefully, but ignore errors if it's already closed.
      try {
        this.#ExpressServer.close((/** @type {NodeJS.ErrnoException | undefined} */ ArgError) => {
          // ignore ERR_SERVER_NOT_RUNNING error as it means the server is already stopped.
          if(ArgError && ArgError.code !== 'ERR_SERVER_NOT_RUNNING') {
            console.error('Error stopping web API server:', ArgError);
          }
          // always resolve to allow shutdown to continue.
          ArgResolve();
        });
      } catch(error) {
        // if close() throws synchronously (e.g., server already closed), just resolve.
        if(error.code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error('Error stopping web API server:', error);
        }
        ArgResolve();
      }
      
      // clear the server reference.
      this.#ExpressServer = null;
    });
  }

  /**
   * Get the port number.
   * @returns {number}
   */
  get PortNumber() {
    return this.#PortNumber;
  }
}

// export the class.
module.exports = WebAPI;
