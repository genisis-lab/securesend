interface Props {
  needRefresh: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

/**
 * Bottom-of-screen toast for service-worker updates. Reload remains
 * user-controlled so we never interrupt an in-flight transfer.
 */
export function UpdateToast({ needRefresh, onUpdate, onDismiss }: Props) {
  if (!needRefresh) return null;

  return (
    <div className="toast" role="status" aria-live="polite">
      <span>A new version of SecureSend is available.</span>
      <div className="row u-gap-8">
        <button className="btn btn--sm" onClick={onUpdate}>
          Reload
        </button>
        <button className="btn btn--ghost btn--sm" onClick={onDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}
