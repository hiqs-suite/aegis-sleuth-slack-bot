#!/usr/bin/env node
'use strict';

// Shadow-diff harness for Phase 5.  It never changes a read source; it only
// reports how the event projection differs from the still-authoritative JSON/API
// artifacts supplied to it.

const fs = require('node:fs');
const path = require('node:path');
const {
  BuildProjectedRebalanceExport,
  FoldReminderReadModels,
} = require('../src/reminders-projection');

/**
 * @param {any} ArgValue
 * @returns {any}
 */
function Canonicalize(ArgValue) {
  if(Array.isArray(ArgValue)) return ArgValue.map(Canonicalize);
  if(!ArgValue || typeof ArgValue !== 'object') return ArgValue;
  const Result = {};
  for(const Key of Object.keys(ArgValue).sort()) Result[Key] = Canonicalize(ArgValue[Key]);
  return Result;
}

/**
 * @param {any} ArgValue
 * @returns {string}
 */
function SerializeCanonical(ArgValue) {
  return `${JSON.stringify(Canonicalize(ArgValue), null, 2)}\n`;
}

/**
 * Byte comparison is deliberately literal: callers may pass raw API bytes.
 * @param {string} ArgAuthoritative
 * @param {string} ArgProjection
 * @returns {{ equal: boolean, authoritativeBytes: number, projectionBytes: number }}
 */
function CompareBytes(ArgAuthoritative, ArgProjection) {
  return {
    equal: ArgAuthoritative === ArgProjection,
    authoritativeBytes: Buffer.byteLength(ArgAuthoritative),
    projectionBytes: Buffer.byteLength(ArgProjection),
  };
}

/**
 * Return semantic mismatch paths after normalizing object-key order. Array
 * ordering deliberately remains meaningful because consumers can observe it.
 * @param {any} ArgAuthoritative
 * @param {any} ArgProjection
 * @param {string} [ArgPath]
 * @returns {string[]}
 */
function FindSemanticDiffPaths(ArgAuthoritative, ArgProjection, ArgPath = '$') {
  if(Object.is(ArgAuthoritative, ArgProjection)) return [];
  const LeftIsArray = Array.isArray(ArgAuthoritative);
  const RightIsArray = Array.isArray(ArgProjection);
  if(LeftIsArray || RightIsArray) {
    if(!LeftIsArray || !RightIsArray) return [ArgPath];
    const Differences = [];
    if(ArgAuthoritative.length !== ArgProjection.length) Differences.push(`${ArgPath}.length`);
    for(let Index = 0; Index < Math.min(ArgAuthoritative.length, ArgProjection.length); Index += 1) {
      Differences.push(...FindSemanticDiffPaths(ArgAuthoritative[Index], ArgProjection[Index], `${ArgPath}[${Index}]`));
    }
    return Differences;
  }
  const LeftIsObject = ArgAuthoritative !== null && typeof ArgAuthoritative === 'object';
  const RightIsObject = ArgProjection !== null && typeof ArgProjection === 'object';
  if(!LeftIsObject || !RightIsObject) return [ArgPath];

  const Keys = new Set([...Object.keys(ArgAuthoritative), ...Object.keys(ArgProjection)]);
  const Differences = [];
  for(const Key of Array.from(Keys).sort()) {
    if(!Object.prototype.hasOwnProperty.call(ArgAuthoritative, Key)
      || !Object.prototype.hasOwnProperty.call(ArgProjection, Key)) {
      Differences.push(`${ArgPath}.${Key}`);
      continue;
    }
    Differences.push(...FindSemanticDiffPaths(ArgAuthoritative[Key], ArgProjection[Key], `${ArgPath}.${Key}`));
  }
  return Differences;
}

/**
 * Semantic comparison normalizes object-key order only. Array ordering remains
 * meaningful until a surface explicitly proves otherwise. Different paths make
 * a parity failure actionable without concealing either value.
 * @param {any} ArgAuthoritative
 * @param {any} ArgProjection
 * @returns {{ equal: boolean, authoritative: any, projection: any, differentPaths: string[] }}
 */
function CompareSemantics(ArgAuthoritative, ArgProjection) {
  const Authoritative = Canonicalize(ArgAuthoritative);
  const Projection = Canonicalize(ArgProjection);
  const DifferentPaths = FindSemanticDiffPaths(Authoritative, Projection);
  return {
    equal: DifferentPaths.length === 0,
    authoritative: Authoritative,
    projection: Projection,
    differentPaths: DifferentPaths,
  };
}

/**
 * @param {string} ArgPath
 * @param {boolean} ArgRequired
 * @returns {any|null}
 */
function ReadJsonFile(ArgPath, ArgRequired) {
  try {
    return JSON.parse(fs.readFileSync(ArgPath, 'utf8'));
  } catch(error) {
    if(!ArgRequired && error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {string} ArgPath
 * @returns {string}
 */
function ReadJsonText(ArgPath) {
  return fs.readFileSync(ArgPath, 'utf8');
}

/**
 * Parse the actual append-only event-store format. EventStore persists one JSON
 * object per line; JSON arrays stay accepted for small fixture inputs. A bad
 * ledger line is a harness error, never an invisible omission.
 * @param {string} ArgText
 * @param {string} ArgPath
 * @returns {any[]}
 */
function ParseEvents(ArgText, ArgPath) {
  const Trimmed = ArgText.trim();
  if(Trimmed.length === 0) return [];
  if(Trimmed.startsWith('[')) {
    const Parsed = JSON.parse(ArgText);
    if(!Array.isArray(Parsed)) throw new Error(`events fixture must be an array: ${ArgPath}`);
    return Parsed;
  }
  const Events = [];
  for(const [Index, Line] of ArgText.split(/\r?\n/).entries()) {
    if(Line.trim().length === 0) continue;
    try {
      Events.push(JSON.parse(Line));
    } catch(error) {
      const ErrorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSONL event at ${ArgPath}:${Index + 1}: ${ErrorMessage}`);
    }
  }
  return Events;
}

/**
 * Compare the three Phase 5 read surfaces.  `rebalance` is optional because it
 * must be captured from the current API separately; when absent the report says
 * so rather than inventing a parity result.
 * @param {{ workspace: string, events: any[], reminders: any[], completed: any[], rebalance?: any|null, rebalanceProjection?: any|null, remindersRaw?: string, completedRaw?: string, rebalanceRaw?: string, rebalanceProjectionRaw?: string }} ArgInput
 * @returns {object}
 */
function BuildParityReport(ArgInput) {
  const Folded = FoldReminderReadModels(ArgInput.events, { strict: false });
  const ProjectedRebalance = BuildProjectedRebalanceExport(Folded.reminders, ArgInput.workspace);
  const Surfaces = {
    reminders: { authoritative: ArgInput.reminders, authoritativeRaw: ArgInput.remindersRaw, projection: Folded.reminders },
    completed: { authoritative: ArgInput.completed, authoritativeRaw: ArgInput.completedRaw, projection: Folded.completed },
  };
  if(ArgInput.rebalance !== null && ArgInput.rebalance !== undefined) {
    // The real export includes Slack-resolved display fields and a capture timestamp.
    // A flag-on API capture therefore supplies the projection side here; the pure
    // shape remains the explicit fallback for fixture diagnosis before that capture.
    Surfaces.rebalance = {
      authoritative: ArgInput.rebalance,
      authoritativeRaw: ArgInput.rebalanceRaw,
      projection: ArgInput.rebalanceProjection ?? ProjectedRebalance,
      projectionRaw: ArgInput.rebalanceProjectionRaw,
    };
  }

  const Report = { workspace: ArgInput.workspace, byteDiffs: {}, semanticDiffs: {}, missingSurfaces: [] };
  for(const [Name, Values] of Object.entries(Surfaces)) {
    Report.byteDiffs[Name] = CompareBytes(
      Values.authoritativeRaw || SerializeCanonical(Values.authoritative),
      Values.projectionRaw || SerializeCanonical(Values.projection)
    );
    Report.semanticDiffs[Name] = CompareSemantics(Values.authoritative, Values.projection);
  }
  if(!Object.prototype.hasOwnProperty.call(Surfaces, 'rebalance')) Report.missingSurfaces.push('rebalance');
  Report.clean = Report.missingSurfaces.length === 0
    && Object.values(Report.byteDiffs).every(ArgDiff => ArgDiff.equal)
    && Object.values(Report.semanticDiffs).every(ArgDiff => ArgDiff.equal);
  return Report;
}

/**
 * @param {string[]} ArgArgv
 * @returns {{ workspace: string, events: string, reminders: string, completed: string, rebalance: string|null, rebalanceProjection: string|null }}
 */
function ParseArgs(ArgArgv) {
  const Values = { workspace: '', events: '', reminders: '', completed: '', rebalance: null, rebalanceProjection: null };
  for(let Index = 0; Index < ArgArgv.length; Index += 2) {
    const Name = ArgArgv[Index];
    const Value = ArgArgv[Index + 1];
    if(!Value || !Object.prototype.hasOwnProperty.call(Values, Name.slice(2))) {
      throw new Error('usage: projection-parity-harness --workspace <name> --events <file> --reminders <file> --completed <file> [--rebalance <json-source-api-file> --rebalance-projection <projection-api-file>]');
    }
    Values[Name.slice(2)] = Value;
  }
  if(!Values.workspace || !Values.events || !Values.reminders || !Values.completed) {
    throw new Error('workspace, events, reminders, and completed inputs are required');
  }
  return Values;
}

function Main() {
  const Options = ParseArgs(process.argv.slice(2));
  const EventsPath = path.resolve(Options.events);
  const EventsRaw = ReadJsonText(EventsPath);
  const RemindersRaw = ReadJsonText(path.resolve(Options.reminders));
  const CompletedRaw = ReadJsonText(path.resolve(Options.completed));
  const RebalanceRaw = Options.rebalance ? ReadJsonText(path.resolve(Options.rebalance)) : null;
  const RebalanceProjectionRaw = Options.rebalanceProjection ? ReadJsonText(path.resolve(Options.rebalanceProjection)) : null;
  const Report = BuildParityReport({
    workspace: Options.workspace,
    events: ParseEvents(EventsRaw, EventsPath),
    reminders: JSON.parse(RemindersRaw),
    completed: JSON.parse(CompletedRaw),
    rebalance: RebalanceRaw ? JSON.parse(RebalanceRaw) : null,
    rebalanceProjection: RebalanceProjectionRaw ? JSON.parse(RebalanceProjectionRaw) : null,
    remindersRaw: RemindersRaw,
    completedRaw: CompletedRaw,
    rebalanceRaw: RebalanceRaw || undefined,
    rebalanceProjectionRaw: RebalanceProjectionRaw || undefined,
  });
  process.stdout.write(`${JSON.stringify(Report, null, 2)}\n`);
  process.exitCode = Report.clean ? 0 : 1;
}

if(require.main === module) Main();

module.exports = {
  BuildParityReport,
  Canonicalize,
  CompareBytes,
  CompareSemantics,
  FindSemanticDiffPaths,
  ParseEvents,
  ReadJsonFile,
  SerializeCanonical,
};
