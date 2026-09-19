// O que o formulário "Entregue" do motoboy manda (FormData, porque leva a
// foto): token, parada, quem recebeu, o ponto do GPS e o arquivo. Fora do
// arquivo "use server" para ser testável e porque lá só entram funções async.
export interface CompleteStopForm {
  token: string;
  stopId: string;
  receivedBy: string | null;
  position: { lat: number; lng: number; accuracyM: number | null } | null;
  photo: File | null;
}

/** Números vindos do FormData ("" = ausente). */
function numberField(formData: FormData, name: string): number | null {
  const raw = formData.get(name);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseCompleteStopForm(formData: FormData): CompleteStopForm {
  const lat = numberField(formData, "lat");
  const lng = numberField(formData, "lng");
  const receivedBy = formData.get("receivedBy");
  const photo = formData.get("photo");
  return {
    token: String(formData.get("token") ?? ""),
    stopId: String(formData.get("stopId") ?? ""),
    receivedBy: typeof receivedBy === "string" && receivedBy.trim() ? receivedBy : null,
    position: lat !== null && lng !== null ? { lat, lng, accuracyM: numberField(formData, "accuracyM") } : null,
    photo: photo instanceof File && photo.size > 0 ? photo : null,
  };
}
