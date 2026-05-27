import { MenuDropdown, MenuItem } from "@liiift-studio/mac-os9-ui";

interface Option {
  value: string;
  label: string;
}

interface Os9SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  disabled?: boolean;
}

/**
 * Mac OS 9 styled dropdown. MenuDropdown renders the dropdown panel with the
 * library's classic chrome; native <select> would otherwise show the OS's
 * default popup (e.g. macOS Sequoia translucent menu), breaking the vibe.
 */
export function Os9Select({ value, onChange, options, disabled }: Os9SelectProps) {
  const current = options.find((o) => o.value === value);
  return (
    <MenuDropdown
      label={current?.label ?? "Select…"}
      disabled={disabled ?? false}
      items={
        <>
          {options.map((opt) => (
            <MenuItem
              key={opt.value}
              label={opt.label}
              checked={opt.value === value}
              onClick={() => onChange(opt.value)}
            />
          ))}
        </>
      }
    />
  );
}
