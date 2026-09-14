// GERADO por scripts/generate-brand-assets.mjs — não editar à mão.
// Fonte da verdade: brand-source/logo.svg. Dimensões lidas do raster final,
// para que todo <img> da marca nasça com width/height (zero CLS).

export interface BrandImage {
  src: string;
  width: number;
  height: number;
}

export interface BrandTone {
  /** Só o monograma, do menor para o maior (srcset). */
  mark: readonly BrandImage[];
  /** Monograma + wordmark + tagline, na horizontal. */
  lockup: BrandImage;
}

export const BRAND: { readonly light: BrandTone; readonly dark: BrandTone } =
  {
  "dark": {
    "mark": [
      {
        "src": "/brand/mark-dark-96.webp",
        "width": 96,
        "height": 113
      },
      {
        "src": "/brand/mark-dark-192.webp",
        "width": 192,
        "height": 227
      },
      {
        "src": "/brand/mark-dark-400.webp",
        "width": 400,
        "height": 473
      },
      {
        "src": "/brand/mark-dark-600.webp",
        "width": 600,
        "height": 709
      },
      {
        "src": "/brand/mark-dark-800.webp",
        "width": 800,
        "height": 945
      }
    ],
    "lockup": {
      "src": "/brand/lockup-dark.webp",
      "width": 1200,
      "height": 512
    }
  },
  "light": {
    "mark": [
      {
        "src": "/brand/mark-light-96.webp",
        "width": 96,
        "height": 113
      },
      {
        "src": "/brand/mark-light-192.webp",
        "width": 192,
        "height": 227
      },
      {
        "src": "/brand/mark-light-400.webp",
        "width": 400,
        "height": 473
      },
      {
        "src": "/brand/mark-light-600.webp",
        "width": 600,
        "height": 709
      },
      {
        "src": "/brand/mark-light-800.webp",
        "width": 800,
        "height": 945
      }
    ],
    "lockup": {
      "src": "/brand/lockup-light.webp",
      "width": 1200,
      "height": 512
    }
  }
};
