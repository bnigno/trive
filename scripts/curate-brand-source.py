#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Monta brand-source/logo.svg (a fonte que scripts/generate-brand-assets.mjs lê)
# a partir das duas entregas do designer, em brand-source/entregue/:
#   logo-canva-2026-09-10.svg   export do Canva (1500×1500): as letras TRIVÉ e
#                               MAISON FÉMININE são <path> de fonte (limpas);
#                               o monograma vinha em bitmap mascarado.
#   trive-completo-2026-09-14.svg  o logo vetorizado (traçado em 26 tons
#                               chapados): o monograma é vetor de verdade; as
#                               letras são traçadas (borda ondulada), então
#                               continuam vindo do Canva.
# Saída: um SVG no espaço do Canva (viewBox 0 0 1500 1500) com os grupos
#   <g id="monograma">  26 <path fill> do vetor, reescalados para a caixa que
#                       o monograma do Canva ocupava (as duas entregas são a
#                       mesma composição em escala 1,3325)
#   <g id="wordmark">   as 5 letras de TRIVÉ (Canva, intocadas)
#   <g id="tagline">    as 14 letras de MAISON FÉMININE (Canva, intocadas)
# Os filetes raster do Canva ficam de fora: o pipeline desenha filetes vetoriais.
#   python3 scripts/curate-brand-source.py
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANVA = ROOT / "brand-source/entregue/logo-canva-2026-09-10.svg"
VETOR = ROOT / "brand-source/entregue/trive-completo-2026-09-14.svg"
OUT = ROOT / "brand-source/logo.svg"

# Caixa (medida no raster) do monograma do Canva, em unidades do viewBox dele.
CANVA_MARK_BOX = (434.75, 235.75, 652.5, 770.75)
# No vetor, o monograma é o primeiro bloco de tinta de cima; abaixo dele há
# um vão sem tinta (y 1344–1463) antes de TRIVÉ.
VETOR_MARK_MAX_Y = 1400

# ---- Canva: grupos de topo por cor de preenchimento -------------------------

def canva_groups(svg):
    body = svg[svg.index("</defs>") + len("</defs>") : svg.rindex("</svg>")]
    tops, depth = [], 0
    for m in re.finditer(r"<g\b[^>]*>|</g>", body):
        if m.group(0).endswith("/>"):
            continue  # <g/> vazio (o espaço do letreiro) não abre nível
        if m.group(0) == "</g>":
            depth -= 1
            if depth == 0:
                tops[-1][1] = m.end()
        else:
            if depth == 0:
                tops.append([m.start(), None])
            depth += 1
    assert depth == 0, "grupos desbalanceados no SVG do Canva"
    out = {"gold": [], "ivory": []}
    for start, end in tops:
        head = body[start : start + 60]
        if 'fill="#c29a5d"' in head:
            out["gold"].append(body[start:end])
        elif 'fill="#f2eae2"' in head:
            out["ivory"].append(body[start:end])
    assert len(out["gold"]) == 5 and len(out["ivory"]) >= 10, (len(out["gold"]), len(out["ivory"]))
    return out

# ---- Vetor: interpretador de path (subpaths em coordenadas absolutas) --------

NUM = r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
TOK = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])|(" + NUM + ")")
ARGC = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}

def parse_path(d):
    """Devolve [{cmds: [(C, [x, y, …])], box: (x0, y0, x1, y1)}] — um por subpath, tudo absoluto."""
    toks = [(m.group(1), m.group(2)) for m in TOK.finditer(d)]
    i, cmd, subpaths, cur = 0, None, [], None
    x = y = sx = sy = 0.0
    cx = cy = None
    while i < len(toks):
        if toks[i][0]:
            cmd = toks[i][0]
            i += 1
            if cmd in "Zz":
                cur["cmds"].append(("Z", []))
                x, y = sx, sy
                cx = cy = None
                continue
        assert cmd, "path sem comando inicial"
        n = ARGC[cmd.upper()]
        args = [float(toks[i + k][1]) for k in range(n)]
        i += n
        rel, C = cmd.islower(), cmd.upper()
        if C == "M":
            x, y = (x + args[0], y + args[1]) if rel else (args[0], args[1])
            sx, sy = x, y
            cx = cy = None
            cur = {"cmds": [("M", [x, y])], "pts": [(x, y)]}
            subpaths.append(cur)
            cmd = "l" if rel else "L"  # coordenadas seguintes viram lineto
            continue
        if C == "L":
            x, y = (x + args[0], y + args[1]) if rel else (args[0], args[1])
            cur["cmds"].append(("L", [x, y]))
            cx = cy = None
        elif C == "H":
            x = x + args[0] if rel else args[0]
            cur["cmds"].append(("L", [x, y]))
            cx = cy = None
        elif C == "V":
            y = y + args[0] if rel else args[0]
            cur["cmds"].append(("L", [x, y]))
            cx = cy = None
        elif C in "CSQT":
            a = [args[k] + (x if k % 2 == 0 else y) for k in range(n)] if rel else list(args)
            if C in "ST":  # ponto de controle refletido
                r = (2 * x - cx, 2 * y - cy) if cx is not None else (x, y)
                a = [r[0], r[1]] + a
                C = "C" if C == "S" else "Q"
            cur["cmds"].append((C, a))
            cx, cy = a[-4], a[-3]
            x, y = a[-2], a[-1]
            cur["pts"].extend((a[k], a[k + 1]) for k in range(0, len(a), 2))
            continue
        else:
            raise ValueError("arco (A) não esperado no vetor do monograma")
        cur["pts"].append((x, y))
    for sp in subpaths:
        xs = [p[0] for p in sp["pts"]]
        ys = [p[1] for p in sp["pts"]]
        sp["box"] = (min(xs), min(ys), max(xs), max(ys))
    return subpaths

def fmt(n):
    s = ("%.2f" % n).rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s

def emit(subpaths, k, tx, ty):
    """Serializa os subpaths aplicando escala k e translação (tx, ty)."""
    parts = []
    for sp in subpaths:
        for c, a in sp["cmds"]:
            coords = [(a[j] * k + (tx if j % 2 == 0 else ty)) for j in range(len(a))]
            parts.append(c + " ".join(fmt(v) for v in coords))
    return "".join(parts)

def vetor_monograma(svg):
    """Os <path> do monograma (subpaths acima do vão), reescalados para a caixa do Canva."""
    paths = re.findall(r'<path\b[^>]*\sfill="(#[0-9a-fA-F]{6})"[^>]*\sd="([^"]+)"', svg)
    assert len(paths) >= 10, "esperava um traçado em camadas de cor"
    layers = []
    for fill, d in paths:
        keep = [sp for sp in parse_path(d) if sp["box"][3] <= VETOR_MARK_MAX_Y]
        if keep:
            layers.append((fill, keep))
    x0 = min(sp["box"][0] for _, sps in layers for sp in sps)
    y0 = min(sp["box"][1] for _, sps in layers for sp in sps)
    x1 = max(sp["box"][2] for _, sps in layers for sp in sps)
    y1 = max(sp["box"][3] for _, sps in layers for sp in sps)
    # As caixas incluem pontos de controle; a proporção real bate com a do
    # Canva (0,847), então a escala vem da altura da tinta medida (1027).
    k = CANVA_MARK_BOX[3] / 1027.0
    tx = CANVA_MARK_BOX[0] - 579.5 * k
    ty = CANVA_MARK_BOX[1] - 315.0 * k
    print(f"monograma do vetor: {len(layers)} camadas, caixa bruta {x0:.0f},{y0:.0f}–{x1:.0f},{y1:.0f}, escala {k:.4f}")
    return "".join(f'<path fill="{fill}" d="{emit(sps, k, tx, ty)}"/>' for fill, sps in layers)

def main():
    canva = CANVA.read_text(encoding="utf-8")
    vetor = VETOR.read_text(encoding="utf-8")
    groups = canva_groups(canva)
    head = canva[: canva.index("</defs>") + len("</defs>")]
    # O cabeçalho do Canva traz <defs> com as máscaras do bitmap antigo; não
    # fazem falta e pesam 35 KB, então o SVG curado nasce com <svg> limpo.
    svg_open = re.search(r"<svg\b[^>]*>", head).group(0)
    out = svg_open
    out += '<g id="monograma">' + vetor_monograma(vetor) + "</g>"
    out += '<g id="wordmark">' + "".join(groups["gold"]) + "</g>"
    out += '<g id="tagline">' + "".join(groups["ivory"]) + "</g>"
    out += "</svg>"
    OUT.write_text(out, encoding="utf-8")
    print(f"ok: {OUT.relative_to(ROOT)} ({len(out) // 1024} KB)")

if __name__ == "__main__":
    sys.exit(main())
