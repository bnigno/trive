// Slug de URL a partir de um nome: sem acento, minúsculo, só [a-z0-9-].
// Vazio quando não sobra nada (quem chama decide o fallback).
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
