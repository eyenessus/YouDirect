/**
 * Fotos reais do fundo das telas de acesso. Todas vêm do Wikimedia Commons com
 * licença que permite uso comercial (CC0 ou CC BY). A CC BY exige crédito ao autor:
 * a página /creditos-fotos lista cada uma (autor, licença e link da origem).
 * Os arquivos foram redimensionados (1600 px) e são recortados pela tela.
 */
export interface AuthPhoto {
  id: number;
  src: string;
  model: string;
  position: string;
  title: string;
  author: string;
  license: 'CC0' | 'CC BY 2.0' | 'CC BY 4.0';
  licenseUrl: string;
  source: string;
}

export const authPhotos: AuthPhoto[] = [
  {
    id: 22,
    src: '/brand/cars/car-22.jpg',
    model: 'LaFerrari',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "LaFerrari in Beverly Hills (14563979888).jpg",
    author: "Axion23",
    license: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
    source: "https://commons.wikimedia.org/wiki/File:LaFerrari_in_Beverly_Hills_(14563979888).jpg",
  },
  {
    id: 26,
    src: '/brand/cars/car-26.jpg',
    model: 'Roma Spider',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "Ferrari Roma Spider at the 2025 Shannons Adelaide Rally (028A4520).jpg",
    author: "Yu Chu Chin",
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    source: "https://commons.wikimedia.org/wiki/File:Ferrari_Roma_Spider_at_the_2025_Shannons_Adelaide_Rally_(028A4520).jpg",
  },
  {
    id: 24,
    src: '/brand/cars/car-24.jpg',
    model: 'LaFerrari',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "Ferrari Laferrari plate vc77.jpg",
    author: "Calreyn88",
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    source: "https://commons.wikimedia.org/wiki/File:Ferrari_Laferrari_plate_vc77.jpg",
  },
  {
    id: 33,
    src: '/brand/cars/car-33.jpg',
    model: 'SF90 Stradale',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "Ferrari SF90 Stradale Mayfair.jpg",
    author: "Calreyn88",
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    source: "https://commons.wikimedia.org/wiki/File:Ferrari_SF90_Stradale_Mayfair.jpg",
  },
  {
    id: 3,
    src: '/brand/cars/car-3.jpg',
    model: '458 Italia',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "White Ferrari 458 Italia front.JPG",
    author: "Tokumeigakarinoaoshima",
    license: 'CC0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    source: "https://commons.wikimedia.org/wiki/File:White_Ferrari_458_Italia_front.JPG",
  },

  {
    id: 8,
    src: '/brand/cars/car-8.jpg',
    model: '812 Superfast',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "2019 Ferrari 812 Superfast - 6496cc 6.5 (800PS) Petrol - Giallo Modena - 01-2025, Front.jpg",
    author: "Harvey Bold",
    license: 'CC0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    source: "https://commons.wikimedia.org/wiki/File:2019_Ferrari_812_Superfast_-_6496cc_6.5_(800PS)_Petrol_-_Giallo_Modena_-_01-2025,_Front.jpg",
  },
  {
    id: 34,
    src: '/brand/cars/car-34.jpg',
    model: 'SF90 XX Stradale',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "Ferrari SF90 XX Stradale 1.jpg",
    author: "Calreyn88",
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    source: "https://commons.wikimedia.org/wiki/File:Ferrari_SF90_XX_Stradale_1.jpg",
  },
  {
    id: 2,
    src: '/brand/cars/car-2.jpg',
    model: '458 Italia',
    /** Enquadramento do recorte (object-position). */
    position: '50% 55%',
    title: "Ferrari 458 ITALIA 2.jpg",
    author: "slayer",
    license: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
    source: "https://commons.wikimedia.org/wiki/File:Ferrari_458_ITALIA_2.jpg",
  },
];
