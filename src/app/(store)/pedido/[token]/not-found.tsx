import Link from "next/link";

export default function OrderNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <p aria-hidden className="text-5xl">
        🔎
      </p>
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
        Pedido não encontrado
      </h1>
      <p className="max-w-md text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
        Não achamos nenhum pedido com este link. Confira se o endereço foi
        copiado por completo — ele costuma chegar por WhatsApp logo após a
        compra.
      </p>
      <Link
        href="/produtos"
        className="rounded-full bg-amber-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-800"
      >
        Ver produtos da loja
      </Link>
    </main>
  );
}
