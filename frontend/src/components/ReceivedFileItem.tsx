import { useEffect, useMemo, useState } from "react";
import { ReceivedItem } from "../lib/transfer";
import { formatBytes } from "../lib/format";
import {
  buildFile,
  canShareFile,
  downloadBlob,
  isImage,
  isVideo,
  shareFile,
} from "../lib/download";

interface Props {
  item: ReceivedItem;
  /** Auto-download non-media items on mount (only for single-item transfers). */
  autoSave: boolean;
  /** Called when the user actually saves/shares the item (confirms possession,
   *  which fires any deferred burn-after-download). */
  onSaved?: () => void;
}

const TEXT_PREVIEW_LIMIT = 4000;

/** A single received item. Streamed-to-disk items (no in-memory blob) show a
 *  simple confirmation; everything else gets the full preview/share/download. */
export function ReceivedFileItem({ item, autoSave, onSaved }: Props) {
  if (item.blob === null) {
    return (
      <div className="received">
        <div className="file-pill">
          <div className="file-pill__meta">
            <div className="file-pill__name">{item.meta.name}</div>
            <div className="file-pill__size">{formatBytes(item.meta.size)}</div>
          </div>
        </div>
        <p className="card__hint u-mt-8 u-center">
          ✅ Saved straight to the location you chose.
        </p>
      </div>
    );
  }
  return <ReceivedFileBody blob={item.blob} meta={item.meta} autoSave={autoSave} onSaved={onSaved} />;
}

/** Body for items that have an in-memory blob (preview / share / download). */
function ReceivedFileBody({
  blob,
  meta,
  autoSave,
  onSaved,
}: {
  blob: Blob;
  meta: ReceivedItem["meta"];
  autoSave: boolean;
  onSaved?: () => void;
}) {
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);

  const file = useMemo(() => buildFile(blob, meta.name, meta.mime), [blob, meta]);
  const shareable = canShareFile(file);
  const image = isImage(meta.mime);
  const video = isVideo(meta.mime);
  const isText = /^text\//i.test(meta.mime) && meta.size <= TEXT_PREVIEW_LIMIT;

  // Object URL for image preview.
  const previewUrl = useMemo(
    () => (image ? URL.createObjectURL(blob) : null),
    [image, blob],
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Load text body for inline preview. Showing the text inline IS delivery for
  // a snippet (the recipient can read/copy it), so confirm the save once shown.
  useEffect(() => {
    if (isText) {
      blob
        .text()
        .then((t) => {
          setTextBody(t);
          onSaved?.();
        })
        .catch(() => setTextBody(null));
    }
  }, [isText, blob, onSaved]);

  // Auto-download non-media items on arrival (single-item transfers only).
  const [autoSaved, setAutoSaved] = useState(false);
  useEffect(() => {
    if (autoSave && !autoSaved && !image && !video && !isText) {
      downloadBlob(blob, meta.name);
      setAutoSaved(true);
      onSaved?.();
    }
  }, [autoSave, autoSaved, image, video, isText, blob, meta.name, onSaved]);

  const handleShare = async () => {
    setSaveHint(null);
    const result = await shareFile(file);
    if (result === "shared") {
      setSaveHint(video ? 'Choose "Save Video".' : 'Choose "Save Image".');
      onSaved?.();
    } else if (result === "failed" || result === "unsupported") {
      downloadBlob(file, file.name);
      setSaveHint("Saved to your downloads.");
      onSaved?.();
    }
  };

  const handleDownload = () => {
    downloadBlob(blob, meta.name);
    setSaveHint("Saved to your downloads.");
    onSaved?.();
  };

  const copyText = async () => {
    if (textBody == null) return;
    try {
      await navigator.clipboard.writeText(textBody);
      setSaveHint("Copied to clipboard.");
    } catch {
      setSaveHint("Couldn't copy — select the text manually.");
    }
  };

  return (
    <div className="received">
      <div className="file-pill">
        <div className="file-pill__meta">
          <div className="file-pill__name">{meta.name}</div>
          <div className="file-pill__size">{formatBytes(meta.size)}</div>
        </div>
      </div>

      {image && previewUrl && (
        <img
          className="received__preview"
          src={previewUrl}
          alt={meta.name}
          onLoad={() => onSaved?.()}
        />
      )}

      {isText && textBody != null && (
        <>
          <pre className="received__text">{textBody}</pre>
          <button className="btn btn--ghost btn--block u-mt-8" onClick={copyText}>
            Copy text
          </button>
        </>
      )}

      {(image || video) && shareable && (
        <button className="btn btn--block u-mt-10" onClick={handleShare}>
          📸 Save to Photos
        </button>
      )}

      <button
        className={`btn btn--block u-mt-10 ${(image || video) && shareable ? "btn--ghost" : ""}`}
        onClick={handleDownload}
      >
        ⬇ {(image || video) && shareable ? "Save to Files instead" : "Save file"}
      </button>

      {saveHint && (
        <p className="card__hint u-mt-8 u-center">
          {saveHint}
        </p>
      )}
    </div>
  );
}
