import { can } from '@yudirect/contracts';
import type { AuthContext } from '../context.js';

/**
 * Minimização de dados pessoais por permissão (LGPD, art. 6º III):
 *  - CPF completo só para quem pode ver o cadastro de motoristas;
 *    os demais (ex.: quem só lida com locações ou financeiro) veem ***.456.789-**;
 *  - RG só para quem pode EDITAR motoristas.
 * Sem usuário identificado, sempre mascara.
 */
export function redactCpf(cpf: string | null): string | null {
  if (!cpf) return cpf;
  const d = cpf.replace(/\D+/g, '');
  if (d.length !== 11) return '***';
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
}

export function cpfForViewer(viewer: AuthContext | null | undefined, cpf: string | null): string | null {
  return viewer && can(viewer.role, viewer.permissions, 'drivers', 'read') ? cpf : redactCpf(cpf);
}

export function rgForViewer(viewer: AuthContext | null | undefined, rg: string | null): string | null {
  return viewer && can(viewer.role, viewer.permissions, 'drivers', 'update') ? rg : null;
}
