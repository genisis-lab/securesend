/**
 * HowItWorks — plain-language explainer shown at the bottom of the app.
 * No jargon: describes the flow and the key requirement that BOTH people keep
 * the app open during the transfer (it's a live, direct connection).
 */
export function HowItWorks() {
  return (
    <section className="how" aria-labelledby="how-title">
      <h2 id="how-title" className="how__title">
        How it works
      </h2>

      <ol className="how__steps">
        <li className="how__step">
          <span className="how__num">1</span>
          <div>
            <strong>Pick a file and create an invite.</strong> Your file gets
            locked (encrypted) right here in your browser before anything leaves
            your device.
          </div>
        </li>
        <li className="how__step">
          <span className="how__num">2</span>
          <div>
            <strong>Share the link.</strong> Send the invite link to your friend
            however you like — message, email, AirDrop. The link holds the secret
            “key” to unlock the file, so only someone with the link can open it.
          </div>
        </li>
        <li className="how__step">
          <span className="how__num">3</span>
          <div>
            <strong>They open the link.</strong> Their browser connects{" "}
            <em>directly</em> to yours and the file streams across, still
            encrypted the whole way. It’s decrypted only on their device.
          </div>
        </li>
        <li className="how__step">
          <span className="how__num">4</span>
          <div>
            <strong>They save it.</strong> Once it finishes, they get a Save
            prompt (photos can go straight to the camera roll on iPhone).
          </div>
        </li>
      </ol>

      <div className="how__callout">
        <AppIcon icon={Hourglass} size={21} weight="duotone" />
        <div>
          <strong>Two ways to send.</strong> With <strong>Live</strong> (the default,
          most private) the encrypted file goes between your browsers in real time
          — SecureSend doesn't save a copy, but you both need the app open at the
          same time, so keep this tab open until it finishes. With{" "}
          <strong>Send for later</strong> the file is encrypted in your browser and
          stored temporarily in encrypted form so your friend can grab it whenever
          — you can close the app once it uploads. Either way, SecureSend never
          receives plaintext files or decryption keys, and stored copies auto-delete
          when the link expires.
        </div>
      </div>

      <p className="how__privacy">
        <AppIcon icon={ShieldCheck} size={19} weight="duotone" />
        <span>
          Your file is protected with AES-256 encryption using a key created in
          your browser. With Live transfers the key is exchanged directly between the
          two browsers (ECDH); with Send-for-later it comes from the secret in your
          link. Either way the key is never sent to us or stored anywhere — we can't
          read your files.
        </span>
      </p>
    </section>
  );
}
import { Hourglass } from "@phosphor-icons/react/Hourglass";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { AppIcon } from "./AppIcon";
