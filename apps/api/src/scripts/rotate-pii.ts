/**
 * Recifra os dados pessoais com a chave atual (PII_KEY) e recalcula o hash
 * de busca do CPF com o pepper atual (PII_PEPPER).
 *
 * Quando usar:
 *  - ao configurar PII_KEY pela primeira vez (sai do formato legado v1);
 *  - antes de trocar o SESSION_SECRET (o legado depende dele);
 *  - ao rotacionar PII_KEY (configure a antiga em PII_KEY_PREVIOUS/_ID).
 *
 * Por padrão só SIMULA. Para gravar:  node dist/scripts/rotate-pii.js --apply
 * Sai com código 1 se algum valor não puder ser decifrado (nada é perdido:
 * o valor original é mantido e listado).
 */
import { loadDotEnv, loadEnv, piiPepper } from '../config/env.js';
import { buildContext } from '../context.js';
import { lookupHash } from '../common/helpers.js';

async function main() {
  loadDotEnv();
  const apply = process.argv.includes('--apply');
  const env = loadEnv();
  if (!env.MONGODB_URI) {
    console.error('Defina MONGODB_URI.');
    process.exit(1);
  }
  if (!env.PII_KEY) {
    console.error('Defina PII_KEY (e PII_KEY_ID) antes de recifrar — sem ela não há para onde migrar.');
    process.exit(1);
  }
  const ctx = await buildContext({ env, skipIndexes: true });
  const c = ctx.mongo.collections;
  const pepper = piiPepper(env);
  const stats = { drivers: 0, inspections: 0, messages: 0, unchanged: 0, failures: [] as string[] };

  const reencrypt = (value: string | null | undefined, where: string): string | null | undefined => {
    if (!value) return value;
    if (ctx.pii.isCurrent(value)) return value;
    const plain = ctx.pii.decrypt(value);
    if (plain === null) {
      stats.failures.push(where);
      return value;
    }
    return ctx.pii.encrypt(plain);
  };

  for await (const d of c.drivers.find({}, { projection: { cpfEncrypted: 1, rgEncrypted: 1, cpfLookupHash: 1 } })) {
    const cpfEnc = reencrypt(d.cpfEncrypted, `driver ${d._id.toHexString()} cpf`);
    const rgEnc = reencrypt(d.rgEncrypted, `driver ${d._id.toHexString()} rg`);
    const cpf = ctx.pii.decrypt(cpfEnc ?? null);
    const hash = cpf ? lookupHash(cpf, pepper) : d.cpfLookupHash;
    if (cpfEnc === d.cpfEncrypted && rgEnc === d.rgEncrypted && hash === d.cpfLookupHash) {
      stats.unchanged += 1;
      continue;
    }
    stats.drivers += 1;
    if (apply) {
      await c.drivers.updateOne(
        { _id: d._id },
        { $set: { cpfEncrypted: cpfEnc ?? null, rgEncrypted: rgEnc ?? null, cpfLookupHash: hash ?? null } },
      );
    }
  }

  for await (const i of c.inspections.find({ requestTokenEnc: { $type: 'string' } }, { projection: { requestTokenEnc: 1 } })) {
    const next = reencrypt(i.requestTokenEnc, `inspection ${i._id.toHexString()} token`);
    if (next === i.requestTokenEnc) continue;
    stats.inspections += 1;
    if (apply) await c.inspections.updateOne({ _id: i._id }, { $set: { requestTokenEnc: next ?? null } });
  }

  for await (const m of c.whatsappMessages.find({ requestPayloadEnc: { $type: 'string' } }, { projection: { requestPayloadEnc: 1 } })) {
    const next = reencrypt(m.requestPayloadEnc, `whatsappMessage ${m._id.toHexString()} payload`);
    if (next === m.requestPayloadEnc) continue;
    stats.messages += 1;
    if (apply) await c.whatsappMessages.updateOne({ _id: m._id }, { $set: { requestPayloadEnc: next ?? null } });
  }

  console.log(`${apply ? 'APLICADO' : 'SIMULAÇÃO (use --apply para gravar)'} — chave atual ${ctx.pii.currentVersion}`);
  console.log(`  motoristas recifrados: ${stats.drivers} (sem mudança: ${stats.unchanged})`);
  console.log(`  tokens de vistoria:    ${stats.inspections}`);
  console.log(`  mensagens WhatsApp:    ${stats.messages}`);
  if (stats.failures.length > 0) {
    console.error(`  NÃO decifrados (${stats.failures.length}) — configure PII_LEGACY_SECRET/PII_KEY_PREVIOUS:`);
    for (const f of stats.failures.slice(0, 50)) console.error(`   - ${f}`);
  }
  await ctx.mongo.close();
  process.exit(stats.failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
