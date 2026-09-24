// A votação das amigas no navegador: um identificador aleatório do aparelho
// (o servidor guarda só o hash — é o que barra o voto repetido) e o voto que
// ela já deu em cada link, para a página abrir no placar quando ela voltar.
// Todo acesso em try/catch: modo privado ou cota cheia não quebram a página.
const VOTER_KEY = "trive-voter-v1";
const VOTED_KEY = "trive-voted-v1";
const CHANGE_EVENT = "trive-voted-change";

let memoryVoterId: string | null = null;

/** O identificador do aparelho; sem storage, vale só enquanto a página estiver aberta. */
export function getVoterId(): string {
  try {
    const stored = window.localStorage.getItem(VOTER_KEY);
    if (stored && /^[0-9a-f-]{36}$/i.test(stored)) return stored;
    const created = crypto.randomUUID();
    window.localStorage.setItem(VOTER_KEY, created);
    return created;
  } catch {
    memoryVoterId ??= crypto.randomUUID();
    return memoryVoterId;
  }
}

function readMap(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(VOTED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function readVotedChoice(token: string): number | null {
  const choice = readMap()[token];
  return typeof choice === "number" && Number.isInteger(choice) ? choice : null;
}

export function writeVotedChoice(token: string, choice: number): void {
  try {
    const map = readMap();
    map[token] = choice;
    window.localStorage.setItem(VOTED_KEY, JSON.stringify(map));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // sem storage, a página só não lembra do voto ao voltar
  }
}

/** Para useSyncExternalStore: muda quando ela vota (aqui ou noutra aba). */
export function subscribeVoted(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

export function votedSnapshot(): string {
  try {
    return window.localStorage.getItem(VOTED_KEY) ?? "";
  } catch {
    return "";
  }
}
