import type {
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import styles from "./Table.module.css";

interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  children: ReactNode;
  /** Wrap in a horizontally scrollable container */
  scrollable?: boolean;
}

export function Table({
  children,
  scrollable = true,
  className,
  ...rest
}: TableProps) {
  const table = (
    <table
      className={[styles.table, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </table>
  );
  if (scrollable) return <div className={styles.wrap}>{table}</div>;
  return table;
}

interface HeadProps {
  children: ReactNode;
}
export function TableHead({ children }: HeadProps) {
  return <thead>{children}</thead>;
}

interface BodyProps {
  children: ReactNode;
}
export function TableBody({ children }: BodyProps) {
  return <tbody>{children}</tbody>;
}

interface RowProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}
export function TableRow({ children, className, onClick }: RowProps) {
  return (
    <tr
      className={[styles.tr, className].filter(Boolean).join(" ")}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
}
export function Th({ children, className, ...rest }: ThProps) {
  return (
    <th className={[styles.th, className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </th>
  );
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
}
export function Td({ children, className, ...rest }: TdProps) {
  return (
    <td className={[styles.td, className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </td>
  );
}
