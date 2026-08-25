export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-5xl font-semibold tracking-[0.3em] text-zinc-900 sm:text-6xl dark:text-zinc-100">
          TRIVË
        </h1>
        <div className="h-px w-24 bg-zinc-300 dark:bg-zinc-700" />
        <p className="text-lg text-zinc-500 dark:text-zinc-400">
          Loja em construção
        </p>
      </div>
      <p className="text-sm text-zinc-400 dark:text-zinc-600">
        Em breve, novidades por aqui.
      </p>
    </main>
  );
}
