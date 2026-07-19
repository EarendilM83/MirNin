// Probe locations offered in the admin UI.
// "LOCAL" is a pseudo-location: the check runs directly from the machine
// hosting this server instead of the Globalping probe network.
export const COUNTRIES = {
  GLOBAL: { name: 'Domain-wide', flag: '🌐' },
  LOCAL: { name: 'This server', flag: '🖥' },
  GE: { name: 'Georgia', flag: '🇬🇪' },
  DE: { name: 'Germany', flag: '🇩🇪' },
  GB: { name: 'United Kingdom', flag: '🇬🇧' },
  FR: { name: 'France', flag: '🇫🇷' },
  NL: { name: 'Netherlands', flag: '🇳🇱' },
  PL: { name: 'Poland', flag: '🇵🇱' },
  ES: { name: 'Spain', flag: '🇪🇸' },
  IT: { name: 'Italy', flag: '🇮🇹' },
  SE: { name: 'Sweden', flag: '🇸🇪' },
  TR: { name: 'Türkiye', flag: '🇹🇷' },
  UA: { name: 'Ukraine', flag: '🇺🇦' },
  AM: { name: 'Armenia', flag: '🇦🇲' },
  AZ: { name: 'Azerbaijan', flag: '🇦🇿' },
  KZ: { name: 'Kazakhstan', flag: '🇰🇿' },
  AE: { name: 'UAE', flag: '🇦🇪' },
  IL: { name: 'Israel', flag: '🇮🇱' },
  IN: { name: 'India', flag: '🇮🇳' },
  SG: { name: 'Singapore', flag: '🇸🇬' },
  JP: { name: 'Japan', flag: '🇯🇵' },
  KR: { name: 'South Korea', flag: '🇰🇷' },
  AU: { name: 'Australia', flag: '🇦🇺' },
  US: { name: 'United States', flag: '🇺🇸' },
  CA: { name: 'Canada', flag: '🇨🇦' },
  BR: { name: 'Brazil', flag: '🇧🇷' },
  MX: { name: 'Mexico', flag: '🇲🇽' },
  ZA: { name: 'South Africa', flag: '🇿🇦' },
};

export const isValidCountry = (code) => Object.hasOwn(COUNTRIES, code);
