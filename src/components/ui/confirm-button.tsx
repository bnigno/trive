"use client";

import { Button, type ButtonProps } from "./form";

/**
 * Botão de submit para ações destrutivas em forms de server action:
 * pede confirmação via window.confirm antes de enviar o form.
 */
export function ConfirmButton({
  confirmMessage,
  variant = "danger",
  onClick,
  ...props
}: ButtonProps & { confirmMessage: string }) {
  return (
    <Button
      {...props}
      type="submit"
      variant={variant}
      onClick={(event) => {
        if (!window.confirm(confirmMessage)) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    />
  );
}
