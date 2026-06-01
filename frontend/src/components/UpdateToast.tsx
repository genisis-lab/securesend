interface Props {
  needRefresh: boolean;
  offlineReady: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

/**
 * Bottom-of-screen toast for service-worker lifecycle events:
 *   - "Update available" with a Reload action (user-controlled so we never
 *     interrupt an in-flight transfer).
 *   - "Ready to work offline" confirmation after the app shell is cached.
 */
export function UpdateToast({ needRefresh, offlineReady, onUpdate, onDismiss }: Props) {
  if (!needRefresh && !offlineReady) return null;

  return (
    <div className="toast" role="status" aria-live="polite">
      {needRefresh ? (
        <>
          <span>A new version of SecureSend is available.</span>
          <div className="row u-gap-8">
            <button className="btn btn--sm" onClick={onUpdate}>
              Reload
            </button>
            <button className="btn btn--ghost btn--sm" onClick={onDismiss} aria-label="Dismiss">
              ✕
            </button>
          </div>
        </>
      ) : (
        <>
          <span>✓ SecureSend is ready to work offline.</span>
          <button className="btn btn--ghost btn--sm" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        </>
      )}
    </div>
  );
}
