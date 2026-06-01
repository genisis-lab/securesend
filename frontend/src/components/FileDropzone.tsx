import { useCallback, useRef, useState } from "react";

interface Props {
  /** Receives one or more selected files. */
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/** Drag-and-drop + click-to-select file picker (supports multiple files). */
export function FileDropzone({ onFiles, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (files && files.length > 0) onFiles(Array.from(files));
    },
    [onFiles],
  );

  return (
    <div
      className={`dropzone${active ? " dropzone--active" : ""}`}
      role="button"
      tabIndex={0}
      aria-label="Select files to send"
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="dropzone__icon">📁</div>
      <div className="dropzone__text">
        Drag &amp; drop files here, or click to browse
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
        disabled={disabled}
      />
    </div>
  );
}
