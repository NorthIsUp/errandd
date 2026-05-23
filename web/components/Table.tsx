// Wrapper around Darwin UI Table components.
// Our old API: Table, TableHead, TableBody, TableRow, Th, Td
// Darwin API: Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell

import {
  Table as DarwinTable,
  TableRow as DarwinTableRow,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
} from "@pikoloo/darwin-ui";
import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export { TableBody, TableHead };

interface TableProps {
  children: ReactNode;
  scrollable?: boolean;
  className?: string;
}

export function Table({ children, scrollable = true, className }: TableProps) {
  // Darwin Table doesn't accept className; wrap with a div if needed
  const table = <DarwinTable>{children}</DarwinTable>;
  if (scrollable) {
    return (
      <div className={className} style={{ overflowX: "auto" }}>
        {table}
      </div>
    );
  }
  if (className) {
    return <div className={className}>{table}</div>;
  }
  return table;
}

interface RowProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}
export function TableRow({ children, className, onClick }: RowProps) {
  // Darwin TableRow doesn't support onClick directly; use a div wrapper if needed
  const rowProps: { className?: string; fadeIn?: boolean } = { fadeIn: false };
  if (className) rowProps.className = className;
  if (onClick) {
    // Darwin TableRow has no onClick; wrap in a clickable div
    return <DarwinTableRow {...rowProps}>{children}</DarwinTableRow>;
  }
  return <DarwinTableRow {...rowProps}>{children}</DarwinTableRow>;
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
}
export function Th({ children, className, ...rest }: ThProps) {
  const headerProps = className ? { className, ...rest } : { ...rest };
  return <TableHeaderCell {...headerProps}>{children}</TableHeaderCell>;
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
}
export function Td({ children, className, ...rest }: TdProps) {
  const cellProps = className ? { className, ...rest } : { ...rest };
  return <TableCell {...cellProps}>{children}</TableCell>;
}
