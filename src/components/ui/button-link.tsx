import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import {
  buttonClassName,
  type ButtonSize,
  type ButtonVariant,
} from "./button-styles";

/** Link com a cara do <Button>: o mesmo desenho para navegar e para agir. */
export function ButtonLink({
  variant = "primary",
  size = "md",
  icon,
  className,
  children,
  ...props
}: ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Ícone à esquerda do texto (já com aria-hidden). */
  icon?: ReactNode;
}) {
  return (
    <Link {...props} className={buttonClassName({ variant, size, className })}>
      {icon}
      {children}
    </Link>
  );
}
