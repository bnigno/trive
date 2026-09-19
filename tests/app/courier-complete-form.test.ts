import { describe, expect, it } from "vitest";

import { parseCompleteStopForm } from "@/app/entrega/[token]/complete-form";

const TOKEN = "3d1a1d59-1b1a-4c3b-9a7e-0b8f2f6b1e11";
const STOP = "7f0f7a3e-2f2c-4a3e-8f6c-1e2d3c4b5a69";

describe("parseCompleteStopForm", () => {
  it("lê token, parada, quem recebeu, o ponto do GPS e a foto", () => {
    const body = new FormData();
    body.set("token", TOKEN);
    body.set("stopId", STOP);
    body.set("receivedBy", " Maria ");
    body.set("lat", "-1.4559");
    body.set("lng", "-48.4901");
    body.set("accuracyM", "9");
    body.set("photo", new File([new Uint8Array([1, 2, 3])], "entrega.jpg", { type: "image/jpeg" }));
    const parsed = parseCompleteStopForm(body);
    expect(parsed).toMatchObject({ token: TOKEN, stopId: STOP, receivedBy: " Maria ", position: { lat: -1.4559, lng: -48.4901, accuracyM: 9 } });
    expect(parsed.photo?.name).toBe("entrega.jpg");
  });

  it("sem GPS o ponto é null; sem precisão, accuracyM null; nome vazio vira null; arquivo vazio não conta como foto", () => {
    const body = new FormData();
    body.set("token", TOKEN);
    body.set("stopId", STOP);
    body.set("receivedBy", "   ");
    body.set("lat", "-1.4559");
    body.set("lng", "");
    body.set("photo", new File([], "vazio.jpg", { type: "image/jpeg" }));
    expect(parseCompleteStopForm(body)).toEqual({ token: TOKEN, stopId: STOP, receivedBy: null, position: null, photo: null });

    const partial = new FormData();
    partial.set("token", TOKEN);
    partial.set("stopId", STOP);
    partial.set("lat", "-1.4559");
    partial.set("lng", "-48.4901");
    expect(parseCompleteStopForm(partial).position).toEqual({ lat: -1.4559, lng: -48.4901, accuracyM: null });
    expect(parseCompleteStopForm(new FormData())).toEqual({ token: "", stopId: "", receivedBy: null, position: null, photo: null });
  });
});
