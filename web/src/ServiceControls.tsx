import type { StaffEvent, Status, TableState } from "../../shared/contracts";

export const COLOURS: Record<Status, string> = {
  ready: "Green",
  occupied: "Yellow",
  needs_cleaning: "Red",
  unknown: "Grey",
};
export const STATE_LABELS: Record<Status, string> = {
  ready: "Ready to serve",
  occupied: "Occupied",
  needs_cleaning: "Needs cleaning",
  unknown: "Verifying",
};

export function ServiceControls({
  state,
  onAction,
  onMonitoring,
  disabled = false,
  unavailable = false,
}: {
  state: Omit<TableState, "last_assessment">;
  disabled?: boolean;
  unavailable?: boolean;
  onAction: (action: StaffEvent["action"], status?: Status) => void;
  onMonitoring: (enabled: boolean) => void;
}) {
  const enabled = state.monitoring_enabled !== false;
  return (
    <div className="service-controls">
      <div className="service-controls-heading">
        <div>
          <strong>Service colour</strong>
          {state.manual_override ? (
            <span data-testid="manual-override" className="manual-badge">
              Manual override · {COLOURS[state.status]}
            </span>
          ) : (
            <span className="auto-mode">{enabled ? "Auto" : "Disabled"}</span>
          )}
        </div>
        <label className="monitoring-control">
          <input
            type="checkbox"
            data-testid="monitoring-toggle"
            disabled={disabled}
            checked={enabled}
            onChange={(event) => onMonitoring(event.target.checked)}
          />
          Monitor table
        </label>
      </div>
      <div
        className="colour-controls"
        role="group"
        aria-label="Set service colour manually"
      >
        {(["needs_cleaning", "occupied", "ready", "unknown"] as Status[]).map(
          (status) => (
            <button
              key={status}
              data-testid={`override-${COLOURS[status].toLowerCase()}`}
              className={`colour-control ${status}`}
              disabled={!enabled || disabled}
              aria-pressed={state.manual_override?.status === status}
              onClick={() => onAction("force_status", status)}
            >
              <span className="status-dot" />
              {COLOURS[status]}
            </button>
          ),
        )}
        <button
          data-testid="override-auto"
          className="colour-control auto-control"
          disabled={!enabled || disabled}
          aria-pressed={!state.manual_override}
          onClick={() => onAction("clear_status_override")}
        >
          Auto
        </button>
      </div>
      <div className="service-controls-note">
        <span data-testid="automatic-status">
          State-based status:{" "}
          <strong>
            {!enabled
              ? "Disabled"
              : unavailable
                ? "Unavailable"
                : STATE_LABELS[state.automatic_status ?? state.status]}
          </strong>
        </span>
        <p>
          {!enabled
            ? "Excluded from floor totals and analysis requests. Enable to monitor this table again."
            : state.manual_override
              ? "Manual colour stays until Auto or Restart. People and surface evidence continue independently."
              : "Choose a colour to hold it manually, including when it differs from the observed state."}
        </p>
      </div>
    </div>
  );
}
