import type { Icon } from "@phosphor-icons/react/lib";

interface Props {
  icon: Icon;
  className?: string;
  size?: number;
  weight?: "regular" | "bold" | "fill" | "duotone";
}

/** Shared icon wrapper so product chrome stays consistent and decorative icons
 * remain hidden from assistive technology. */
export function AppIcon({
  icon: IconComponent,
  className,
  size = 20,
  weight = "regular",
}: Props) {
  return (
    <IconComponent
      aria-hidden
      className={className}
      size={size}
      weight={weight}
    />
  );
}
