interface Props {
  /** Navigate to the home view. */
  onHome: () => void;
  /** Whether we're already on the home view (hides the Home button there). */
  isHome: boolean;
  /** Show an "Install" entry point in the header (capable, not-yet-installed). */
  showInstall?: boolean;
  /** Show a transient "✓ Installed" confirmation instead of the install button. */
  justInstalled?: boolean;
  /** Click handler for the header Install button. */
  onInstall?: () => void;
}

/**
 * Product masthead. On the home route it becomes the editorial context column;
 * on receive routes it collapses to compact navigation.
 */
export function Hero({ onHome, isHome, showInstall, justInstalled, onInstall }: Props) {
  return (
    <header className="hero">
      <div className="hero__bar">
        <button
          type="button"
          className="brand brand--button"
          onClick={onHome}
          aria-label="SecureSend home"
        >
          <div className="brand__logo">
            <AppIcon icon={LockKey} size={22} weight="bold" />
          </div>
          <div className="brand__text">
            <div className="brand__title">SecureSend</div>
            <div className="brand__sub">Encrypted P2P file transfer</div>
          </div>
        </button>

        <div className="row u-gap-8">
          {justInstalled ? (
            <span className="installed-badge" role="status" aria-live="polite">
              <AppIcon icon={Check} size={16} weight="bold" /> Installed
            </span>
          ) : (
            showInstall && (
              <button
                type="button"
                className="btn btn--ghost home-btn"
                onClick={onInstall}
                aria-label="Install SecureSend app"
              >
                <AppIcon icon={ArrowDown} size={17} weight="bold" /> Install app
              </button>
            )
          )}
          {!isHome && (
            <button type="button" className="btn btn--ghost home-btn" onClick={onHome}>
              <AppIcon icon={House} size={17} weight="bold" /> Home
            </button>
          )}
        </div>
      </div>

      {isHome && (
        <div className="hero__intro">
          <span className="hero__badge">
            <AppIcon icon={ShieldCheck} size={16} weight="fill" />
            End-to-end encrypted · zero server storage
          </span>
          <h1 className="hero__headline">
            Send files that <span className="hero__headline-accent">only</span> your
            recipient can open
          </h1>
          <p className="hero__lead">
            Files are encrypted in your browser and streamed directly,
            peer-to-peer. No uploads, no server copies — just a private link.
          </p>
        </div>
      )}
    </header>
  );
}
import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { Check } from "@phosphor-icons/react/Check";
import { House } from "@phosphor-icons/react/House";
import { LockKey } from "@phosphor-icons/react/LockKey";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { AppIcon } from "./AppIcon";
