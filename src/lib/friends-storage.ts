// A votação das amigas no navegador: um identificador aleatório do aparelho
// (o servidor guarda só o hash — é o que barra o voto repetido) e o voto que
// ela já deu em cada link, para a página abrir no placar quando ela voltar.
// Todo acesso em try/catch: modo privado ou cota cheia não quebram a página.
const VOTER_KEY = "trive-voter-v1";
const VOTED_KEY = "trive-voted-v1";
const CHANGE_EVENT = "trive-voted-change";

let memoryVoterId: string | null = null;

/** uuid v4 também em celular antigo (iOS < 15.4 não tem crypto.randomUUID). */
function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** O identificador do aparelho; sem storage, vale só enquanto a página estiver aberta. */
export function getVoterId(): string {
  try {
    const stored = window.localStorage.getItem(VOTER_KEY);
    if (stored && /^[0-9a-f-]{36}$/i.test(stored)) return stored;
    const created = randomUuid();
    window.localStorage.setItem(VOTER_KEY, created);
    return created;
  } catch {
    memoryVoterId ??= randomUuid();
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
