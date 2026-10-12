// Perfil escolhido pelo usuário para um agente: nome e aparência (parcial: o que não vier sai da semente).
// Compartilhado pelo servidor (valida e persiste) e pelo cliente (monta o editor e aplica no sprite).

export const HAIR_STYLES = [
  'short', 'buzz', 'spiky', 'side_part', 'curly', 'afro', 'bob', 'long', 'ponytail', 'bun', 'pigtails', 'mohawk', 'bald', 'wavy',
] as const;
export const TOP_STYLES = ['tshirt', 'hoodie', 'shirt_tie', 'sweater', 'jacket', 'blouse', 'polo'] as const;
export const BOTTOM_STYLES = ['pants', 'shorts', 'skirt', 'dress'] as const;
export const SHOE_STYLES = ['flat', 'heels'] as const;
export const ACCESSORIES = ['none', 'glasses', 'sunglasses', 'headphones', 'cap', 'beanie', 'earrings', 'bow'] as const;
export const FACIAL_HAIR = ['none', 'stubble', 'beard', 'mustache', 'goatee'] as const;
export const LOOKS = ['f', 'm'] as const;

/** Campos de cor (#rrggbb) que o editor deixa trocar. */
export const COLOR_FIELDS = ['skin', 'hair', 'eyes', 'top', 'topAccent', 'bottom', 'shoes', 'accessoryColor'] as const;

export interface AppearanceOverride {
  look?: (typeof LOOKS)[number];
  hairStyle?: (typeof HAIR_STYLES)[number];
  topStyle?: (typeof TOP_STYLES)[number];
  bottomStyle?: (typeof BOTTOM_STYLES)[number];
  shoeStyle?: (typeof SHOE_STYLES)[number];
  accessory?: (typeof ACCESSORIES)[number];
  facialHair?: (typeof FACIAL_HAIR)[number];
  skin?: string;
  hair?: string;
  eyes?: string;
  top?: string;
  topAccent?: string;
  bottom?: string;
  shoes?: string;
  accessoryColor?: string;
}

export interface AgentProfile {
  name?: string;
  appearance?: AppearanceOverride;
}

export const NAME_MAX = 20;

export class ProfileError extends Error {}

const ENUMS: Record<string, readonly string[]> = {
  look: LOOKS,
  hairStyle: HAIR_STYLES,
  topStyle: TOP_STYLES,
  bottomStyle: BOTTOM_STYLES,
  shoeStyle: SHOE_STYLES,
  accessory: ACCESSORIES,
  facialHair: FACIAL_HAIR,
};

/** Nome aceito: 1..20 caracteres, letras (com acento), números, espaço, ponto, hífen e apóstrofo. */
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') throw new ProfileError('nome inválido');
  const name = v.replace(/\s+/g, ' ').trim();
  if (!name) throw new ProfileError('o nome não pode ficar vazio');
  if ([...name].length > NAME_MAX) throw new ProfileError(`nome com no máximo ${NAME_MAX} caracteres`);
  if (!/^[\p{L}\p{N} .'-]+$/u.test(name)) throw new ProfileError('use só letras, números, espaço, ponto, hífen e apóstrofo');
  return name;
}

/** Aparência aceita: só chaves conhecidas, enums válidos e cores #rrggbb. Chaves desconhecidas são recusadas. */
export function cleanAppearance(v: unknown): AppearanceOverride {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ProfileError('aparência inválida');
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') throw new ProfileError(`valor inválido em ${k}`);
    if (k in ENUMS) {
      if (!ENUMS[k].includes(val)) throw new ProfileError(`opção inválida em ${k}`);
    } else if ((COLOR_FIELDS as readonly string[]).includes(k)) {
      if (!/^#[0-9a-f]{6}$/i.test(val)) throw new ProfileError(`cor inválida em ${k}`);
    } else throw new ProfileError(`campo desconhecido: ${k}`);
    out[k] = val.toLowerCase();
  }
  if (out.look === 'f') out.facialHair = 'none';
  return out as AppearanceOverride;
}

export function cleanProfile(v: unknown): AgentProfile {
  if (typeof v !== 'object' || v === null) throw new ProfileError('esperado {name?, appearance?}');
  const b = v as { name?: unknown; appearance?: unknown };
  const out: AgentProfile = {};
  if (b.name !== undefined && b.name !== '') out.name = cleanName(b.name);
  if (b.appearance !== undefined) out.appearance = cleanAppearance(b.appearance);
  return out;
}
