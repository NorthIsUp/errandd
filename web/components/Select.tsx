// Select using Darwin UI's Select component.
// Converts native <option> children into Darwin Select.Option children.

import { Select as DarwinSelect } from "@pikoloo/darwin-ui";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { Children, isValidElement } from "react";

interface Props
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  onChange?: (e: { target: { value: string } }) => void;
  children?: ReactNode;
}

export function Select({
  value,
  onChange,
  disabled,
  className,
  children,
}: Props) {
  // Convert native <option> elements into Darwin Select.Option
  const options = Children.toArray(children).map((child) => {
    if (isValidElement(child)) {
      const p = child.props as {
        value?: string;
        children?: ReactNode;
        disabled?: boolean;
      };
      const val = String(p.value ?? "");
      const label = p.children;
      const optProps: { value: string; disabled?: boolean } = { value: val };
      if (p.disabled) optProps.disabled = true;
      return (
        <DarwinSelect.Option key={val} {...optProps}>
          {label}
        </DarwinSelect.Option>
      );
    }
    return null;
  });

  const selectProps: {
    value?: string;
    onChange?: (e: { target: { value: string } }) => void;
    disabled?: boolean;
    className?: string;
  } = {
    value: typeof value === "string" ? value : String(value ?? ""),
  };
  if (onChange) selectProps.onChange = onChange;
  if (disabled) selectProps.disabled = disabled;
  if (className) selectProps.className = className;

  return <DarwinSelect {...selectProps}>{options}</DarwinSelect>;
}
