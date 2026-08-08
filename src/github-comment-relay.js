
// import required modules.
const GitHubSyncModule = require('./github-sync-module');
const { ResolveMentionsForExternalDisplayAsync } = require('./slack-message-pipeline');

/**
 * @typedef {import('./slack-app')} SlackApp
 * @typedef {import('./slack-app').MessageEventInfo} MessageEventInfo
 * @typedef {import('./reminders-module').ReminderInfo} ReminderInfo
 */

// triggers used to stop relaying a thread to GitHub. Any thread reply containing
// one of these emojis or matching the text command is treated as a stop signal.
// Emoji codepoints are matched directly so the optional U+FE0F variation selector
// after `\u{23F9}` does not affect detection.
const STOP_RELAY_EMOJIS = Object.freeze([
  '\u{1F6D1}', // 🛑 stop sign.
  '\u{23F9}',  // ⏹ stop button (with or without FE0F variation selector).
]);
const STOP_RELAY_TEXT_PATTERN = /\bstop\s+relay\b/i;

/**
 * Decide whether a Slack message should stop the GitHub relay for its thread.
 * @param {string} ArgMessageText Message text to inspect.
 * @returns {boolean}
 */
function ContainsStopRelayTrigger(ArgMessageText) {
  if(!ArgMessageText) return false;
  for(const Emoji of STOP_RELAY_EMOJIS)
    if(ArgMessageText.includes(Emoji)) return true;
  return STOP_RELAY_TEXT_PATTERN.test(ArgMessageText);
}

/**
 * Relays Slack thread messages to GitHub issue/PR comments for monitored reminders.
 */
class GitHubCommentRelay {
  /**
   * Slack app instance.
   * @type {SlackApp}
   */
  #SlackApp;

  /**
   * Getter for the pending reminders queue.
   * @type {() => ReminderInfo[]}
   */
  #GetPendingReminders;

  /**
   * Callback to persist the reminders queue after relay state changes.
   * @type {() => Promise<void>}
   */
  #SaveRemindersAsync;

  /**
   * Optional ledger hook: append one thread-scoped relay-state event. OPTIONAL on purpose — the
   * ledger is non-authoritative, so a relay constructed without it (every unit test, and any caller
   * predating the schema expansion) behaves exactly as before.
   * @type {((ArgThreadKey: string, ArgState: { relayStarted: boolean, relayStopped: boolean }) => void)|null}
   */
  #EmitRelayStateChanged = null;

  /**
   * Initialize a new GitHub comment relay.
   * @param {SlackApp} ArgSlackApp Slack app instance.
   * @param {() => ReminderInfo[]} ArgGetPendingReminders Getter for pending reminders.
   * @param {() => Promise<void>} ArgSaveRemindersAsync Callback to persist reminders to disk.
   * @param {((ArgThreadKey: string, ArgState: { relayStarted: boolean, relayStopped: boolean }) => void)|null} [ArgEmitRelayStateChanged]
   *   Best-effort ledger hook, called only AFTER the authoritative save succeeds.
   */
  constructor(ArgSlackApp, ArgGetPendingReminders, ArgSaveRemindersAsync, ArgEmitRelayStateChanged = null) {
    if(typeof ArgSaveRemindersAsync !== 'function')
      throw new Error('[github-comment-relay] ArgSaveRemindersAsync callback is required');
    this.#SlackApp = ArgSlackApp;
    this.#GetPendingReminders = ArgGetPendingReminders;
    this.#SaveRemindersAsync = ArgSaveRemindersAsync;
    this.#EmitRelayStateChanged = typeof ArgEmitRelayStateChanged === 'function' ? ArgEmitRelayStateChanged : null;
  }

  /**
   * Append one thread-scoped relay-state event, if a ledger hook was supplied. Never throws: the
   * ledger is a side log and must never break a relay that has already been persisted.
   * @param {string} ArgThreadKey Thread identity — `OriginalThreadTs ?? OriginalMessageID` (GH-27).
   * @param {boolean} ArgRelayStarted
   * @param {boolean} ArgRelayStopped
   */
  #EmitThreadRelayState(ArgThreadKey, ArgRelayStarted, ArgRelayStopped) {
    if(!this.#EmitRelayStateChanged || !ArgThreadKey) return;
    try {
      this.#EmitRelayStateChanged(ArgThreadKey, { relayStarted: ArgRelayStarted, relayStopped: ArgRelayStopped });
    } catch(error) {
      this.#SlackApp.Logger.warn('[github-comment-relay] relay-state event emit failed (non-fatal):', error);
    }
  }

  /**
   * Handle a Slack message event and relay thread replies to GitHub when applicable.
   * @param {SlackApp} ArgSlackApp Slack app instance.
   * @param {MessageEventInfo} ArgEventInfo Message event payload.
   * @returns {Promise<boolean>} Always false so downstream handlers still run.
   */
  async OnMessageAsync(ArgSlackApp, ArgEventInfo) {
    try {
      // only process thread replies (thread_ts present and different from ts).
      if(!ArgEventInfo.thread_ts || ArgEventInfo.thread_ts === ArgEventInfo.ts) return false;

      // skip bot's own messages.
      if(!ArgEventInfo.user || ArgEventInfo.user === ArgSlackApp.BotUserID) return false;

      // check that the workspace has a GitHub PAT configured.
      const WorkspacePat = ArgSlackApp.WorkspaceInfo.GITHUB_PAT;
      if(!WorkspacePat) return false;

      // find reminders whose original message matches this thread's parent.
      // OriginalThreadTs is the root thread ts (set when the original message was itself a thread reply).
      // Fall back to OriginalMessageID for top-level messages and legacy reminders without OriginalThreadTs.
      const MatchingReminders = this.#GetPendingReminders().filter(ArgReminder =>
        (ArgReminder.OriginalThreadTs ?? ArgReminder.OriginalMessageID) === ArgEventInfo.thread_ts &&
        ArgReminder.OriginalChannelID === ArgEventInfo.channel &&
        Array.isArray(ArgReminder.GitHubUrls) &&
        ArgReminder.GitHubUrls.length > 0
      );

      if(MatchingReminders.length === 0) return false;

      // check if any matching reminder has already had its relay stopped.
      // all reminders sharing this thread share the same stop state — check the first one.
      if(MatchingReminders.some(ArgR => ArgR.GitHubRelayStopped)) return false;

      const MessageText = typeof ArgEventInfo.text === 'string' ? ArgEventInfo.text : '';

      // check whether this message contains a stop-relay trigger (🛑, ⏹, or "stop relay").
      if(ContainsStopRelayTrigger(MessageText)) {
        // mark all matching reminders as relay-stopped in memory.
        for(const StoppedReminder of MatchingReminders)
          StoppedReminder.GitHubRelayStopped = true;

        // persist the stopped state; only acknowledge with a reaction when the save succeeds
        // so users know the stop will survive an app restart.
        let SaveSucceeded = false;
        try {
          await this.#SaveRemindersAsync();
          SaveSucceeded = true;
        } catch(error) {
          this.#SlackApp.Logger.error('[github-comment-relay] failed to save relay-stopped state:', error);
        }

        if(SaveSucceeded) {
          await ArgSlackApp.AddReactionAsync(ArgEventInfo.channel, ArgEventInfo.ts, 'no_entry_sign');
          this.#SlackApp.Logger.info(
            `[github-comment-relay] relay stopped for thread ${ArgEventInfo.thread_ts} in channel ${ArgEventInfo.channel}`
          );
          // Emit the thread's resulting state, not a delta, so the fold is a plain assignment.
          // Only after the authoritative save succeeded — the ledger must never claim a stop the
          // JSON store does not have.
          this.#EmitThreadRelayState(
            ArgEventInfo.thread_ts,
            MatchingReminders.some(ArgR => Boolean(ArgR.GitHubRelayStarted)),
            true
          );
        }
        return false;
      }

      // skip messages with no text (e.g. file-share-only, message_changed subtypes).
      if(!MessageText) return false;

      // collect unique GitHub URLs across all matching reminders.
      const UniqueUrls = [...new Set(MatchingReminders.flatMap(ArgR => ArgR.GitHubUrls ?? []))];

      // resolve the Slack user's display name. GH-432: fall back to a plain `@id` (not `<@id>`) on
      // lookup failure — this comment leaves Slack's rendering context, so the raw mrkdwn token
      // would show up verbatim to a GitHub reader instead of a resolved-or-fallback mention.
      const DisplayName = await ArgSlackApp.GetUserDisplayNameAsync(ArgEventInfo.user) || `@${ArgEventInfo.user}`;

      // determine whether this is the first relayed message for these reminders.
      const IsFirstRelay = MatchingReminders.every(ArgR => !ArgR.GitHubRelayStarted);

      // fetch the Slack thread permalink when this is the first relay so GitHub readers can navigate back.
      let SlackThreadUrl = null;
      if(IsFirstRelay) {
        SlackThreadUrl = await ArgSlackApp.GetPermaLinkAsync(ArgEventInfo.channel, ArgEventInfo.thread_ts);
      }

      // GH-432: resolve raw `<@U...>` mentions in the message body before it leaves Slack — Slack's
      // own client resolves them, a GitHub comment does not (same class of bug as GH-428).
      const ResolvedMessageText = await ResolveMentionsForExternalDisplayAsync(ArgSlackApp, MessageText);

      // build the GitHub comment body.
      const CommentBody = this.#BuildCommentBody(DisplayName, ResolvedMessageText, SlackThreadUrl);

      // post the comment to each GitHub issue/PR.
      let SuccessCount = 0;
      for(const Url of UniqueUrls) {
        const Posted = await this.#PostGitHubCommentAsync(Url, CommentBody, WorkspacePat);
        if(Posted) SuccessCount++;
      }

      if(SuccessCount > 0) {
        // add a reaction to the Slack message to confirm relay.
        await ArgSlackApp.AddReactionAsync(ArgEventInfo.channel, ArgEventInfo.ts, 'octocat');

        // Mark every reminder sharing this thread as relay-started — keyed on which ones are not
        // already marked, rather than on IsFirstRelay. A reminder created after the relay began
        // still belongs to a thread that is relaying, but the old IsFirstRelay-only write recorded
        // it as never-relayed forever. That also made the JSON store and the thread-scoped ledger
        // event disagree about the same thread, so parity could never hold. The save stays
        // conditional, so a steady-state relay still costs no extra write.
        const NewlyStarted = MatchingReminders.filter(ArgR => !ArgR.GitHubRelayStarted);
        if(NewlyStarted.length > 0) {
          for(const StartedReminder of NewlyStarted)
            StartedReminder.GitHubRelayStarted = true;

          let StartSaveSucceeded = false;
          try {
            await this.#SaveRemindersAsync();
            StartSaveSucceeded = true;
          } catch(error) {
            this.#SlackApp.Logger.error('[github-comment-relay] failed to save relay-started state:', error);
          }

          // relayStopped is definitively false here: the guard above returns early when any
          // reminder in this thread is stopped, so a started event can never race a stopped one.
          if(StartSaveSucceeded) this.#EmitThreadRelayState(ArgEventInfo.thread_ts, true, false);
        }
      }

    } catch(error) {
      this.#SlackApp.Logger.error('[github-comment-relay] unexpected error:', error);
    }

    // never consume the message — let downstream handlers process it too.
    return false;
  }

  /**
   * Build a formatted GitHub comment body. `ArgMessageText` must already be resolved via
   * `ResolveMentionsForExternalDisplayAsync` (GH-432) — this just lays out the quote block, it does
   * not touch mention markup.
   * @param {string} ArgDisplayName Slack user display name.
   * @param {string} ArgMessageText Original Slack message text, mentions already resolved.
   * @param {string|null} ArgSlackThreadUrl Slack thread permalink to include on first relay (null to omit).
   * @returns {string}
   */
  #BuildCommentBody(ArgDisplayName, ArgMessageText, ArgSlackThreadUrl) {
    const Lines = [
      `**${ArgDisplayName}** (via Slack):`,
      '',
      `> ${ArgMessageText.replace(/\n/g, '\n> ')}`,
    ];

    if(ArgSlackThreadUrl) {
      Lines.push('');
      Lines.push(`[View Slack thread](${ArgSlackThreadUrl})`);
    }

    Lines.push('');
    Lines.push('---');
    Lines.push('_Relayed from Slack by Sleuth_');

    return Lines.join('\n');
  }

  /**
   * Post a comment to a GitHub issue or pull request.
   * @param {string} ArgGitHubUrl GitHub issue or PR URL.
   * @param {string} ArgCommentBody Comment body text (Markdown).
   * @param {string} ArgWorkspacePat GitHub personal access token.
   * @returns {Promise<boolean>} True if the comment was posted successfully.
   */
  async #PostGitHubCommentAsync(ArgGitHubUrl, ArgCommentBody, ArgWorkspacePat) {
    const ParsedUrl = GitHubSyncModule.ParseGitHubUrl(ArgGitHubUrl);
    if(!ParsedUrl) {
      this.#SlackApp.Logger.warn(`[github-comment-relay] could not parse GitHub URL: ${ArgGitHubUrl}`);
      return false;
    }

    // both issues and PRs use the issues comment endpoint.
    const ApiUrl = `https://api.github.com/repos/${ParsedUrl.owner}/${ParsedUrl.repo}/issues/${ParsedUrl.number}/comments`;

    try {
      const Response = await fetch(ApiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ArgWorkspacePat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: ArgCommentBody }),
      });

      if(Response.status === 201) {
        this.#SlackApp.Logger.info(`[github-comment-relay] comment posted to ${ArgGitHubUrl}`);
        return true;
      }

      this.#SlackApp.Logger.warn(`[github-comment-relay] GitHub API returned ${Response.status} for ${ApiUrl}`);
      return false;
    } catch(/** @type {any} */ error) {
      this.#SlackApp.Logger.warn(`[github-comment-relay] network error posting to ${ApiUrl}:`, error);
      return false;
    }
  }
}

// export the class.
module.exports = GitHubCommentRelay;
