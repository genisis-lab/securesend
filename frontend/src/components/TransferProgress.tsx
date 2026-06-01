import { useEffect, useRef } from "react";
import { TransferProgress as Progress } from "../lib/transfer";
import { formatBytes, formatEta, formatPercent, formatSpeed } from "../lib/format";

interface Props {
  progress: Progress | null;
  label: string;
}

/** Visual progress bar with speed, ETA, and byte counters. */
export function TransferProgressView({ progress, label }: Props) {
  const fraction = progress?.fraction ?? 0;
  const multi = !!progress && progress.totalItems > 1;

  // Drive the fill width via a CSS custom property using the CSSOM (setProperty)
  // rather than an inline style attribute, so the CSP can drop 'unsafe-inline'.
  const fillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fillRef.current?.style.setProperty("--fill", `${fraction * 100}%`);
  }, [fraction]);

  return (
    <div className="progress" aria-live="polite">
      <div className="row u-justify-between">
        <span className="status">
          <span className="dot dot--live" /> {label}
        </span>
        <strong>{formatPercent(fraction)}</strong>
      </div>

      {progress && progress.currentName && (
        <div className="progress__file" title={progress.currentName}>
          {multi && (
            <span className="progress__count">
              {Math.min(progress.items + 1, progress.totalItems)}/{progress.totalItems}
            </span>
          )}
          <span className="progress__name">{progress.currentName}</span>
        </div>
      )}

      <div
        className="progress__bar u-mt-8"
        role="progressbar"
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress__fill" ref={fillRef} />
      </div>

      <div className="stats">
        <div className="stat">
          <div className="stat__value">
            {progress ? formatSpeed(progress.bytesPerSecond) : "—"}
          </div>
          <div className="stat__label">Speed</div>
        </div>
        <div className="stat">
          <div className="stat__value">
            {progress ? formatEta(progress.etaSeconds) : "—"}
          </div>
          <div className="stat__label">ETA</div>
        </div>
        <div className="stat">
          <div className="stat__value">
            {progress
              ? `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`
              : "—"}
          </div>
          <div className="stat__label">Transferred</div>
        </div>
      </div>
    </div>
  );
}
