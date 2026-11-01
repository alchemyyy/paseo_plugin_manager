import type { OperationKind, SummaryVariant } from "../shared/contracts";

/** What a check or update did to one plugin */
export type Outcome =
  | { kind: "available"; commits: number | null }
  | { kind: "current" }
  | { kind: "untracked"; reason: string }
  | { kind: "updated"; commits: number | null }
  /** Nothing new to apply; Paseo reloaded the plugin from disk. `note` says why nothing was fetched */
  | { kind: "reloaded"; note: string | null }
  | { kind: "failed"; reason: string };

export interface PluginOutcome {
  name: string;
  /** This plugin manager, which reloads itself only after the operation has finished */
  self: boolean;
  outcome: Outcome;
}

export interface Summary {
  message: string;
  variant: SummaryVariant;
}

const MAX_REASON_LENGTH = 160;

/** One line for a toast; the full reason stays on the plugin's row */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "")?.trim() ?? "";
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH - 1)}…` : line;
}

export function summarize(kind: OperationKind, single: boolean, outcomes: readonly PluginOutcome[]): Summary {
  if (single && outcomes.length === 1) return summarizeOne(kind, outcomes[0]);
  const progressed = outcomes.filter(({ outcome }) => outcome.kind === (kind === "check" ? "available" : "updated"));
  const failed = outcomes.filter(({ outcome }) => outcome.kind === "failed");
  const parts: string[] = [];
  if (progressed.length > 0) {
    parts.push(
      kind === "check"
        ? `${plural(progressed.length, "plugin update")} available: ${names(progressed)}`
        : `Updated ${names(progressed)}`,
    );
  } else if (failed.length === 0) {
    parts.push("All plugins are up to date");
  } else if (kind === "check") {
    parts.push("No updates found");
  }
  if (failed.length > 0) {
    const reason = failed.length === 1 && failed[0].outcome.kind === "failed" ? `: ${firstLine(failed[0].outcome.reason)}` : "";
    parts.push(`could not ${kind} ${names(failed)}${reason}`);
  }
  const message = parts.join("; ");
  let variant: SummaryVariant = "success";
  if (failed.length > 0) variant = progressed.length === 0 && kind === "update" ? "error" : "warning";
  return { message: message.charAt(0).toUpperCase() + message.slice(1), variant };
}

function summarizeOne(kind: OperationKind, { name, self, outcome }: PluginOutcome): Summary {
  switch (outcome.kind) {
    case "available":
      return {
        message: `${name}: ${outcome.commits === null ? "update" : plural(outcome.commits, "new commit")} available`,
        variant: "success",
      };
    case "current":
      return { message: `${name} is up to date`, variant: "success" };
    case "untracked":
      return { message: `${name} ${outcome.reason}`, variant: "warning" };
    case "updated": {
      const commits = outcome.commits === null ? "" : ` (${plural(outcome.commits, "commit")})`;
      return { message: `Updated ${name}${commits}${self ? "; reloading it" : ""}`, variant: "success" };
    }
    case "reloaded":
      return {
        message: `${name} ${outcome.note ?? "is up to date"}; ${self ? "reloading" : "reloaded"} it`,
        variant: outcome.note === null ? "success" : "warning",
      };
    case "failed":
      return { message: `Could not ${kind} ${name}: ${firstLine(outcome.reason)}`, variant: "error" };
  }
}

function names(outcomes: readonly PluginOutcome[]): string {
  return outcomes.map(({ name }) => name).join(", ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
