// Linha de comando de backup e restauração (use dentro do contêiner/servidor, com as mesmas variáveis de ambiente do servidor):
//   node server/src/backupCli.js backup  [--dir PASTA] [--keep N]
//   node server/src/backupCli.js verify  ARQUIVO.zip
//   node server/src/backupCli.js restore ARQUIVO.zip --to PASTA_DE_DADOS [--force]      (o servidor precisa estar parado)
import path from 'node:path';
import * as core from './backupCore.js';

const lang = ((process.env.FLUXO_CLI_LANG || process.env.LANG || 'en').slice(0, 2));
const M = {
  en: { saved: 'Backup saved', dbs: 'databases', verifyOk: 'The backup is intact: every database matches its checksum and content.', verifyBad: 'PROBLEM: this backup does not match what was saved. Do not use it.', restored: 'Restored to', old: 'The previous files were kept in', same: 'Every restored database was checked against the backup (integrity and content): identical.', diff: 'PROBLEM: a restored database does not match the backup.', key: 'WARNING: the encryption key now set on this machine is not the one used when the backup was made. Tax IDs, bank tokens and 2FA secrets will not open until you set the original FLUXO_ENCRYPTION_KEY.', usage: 'Usage: backupCli.js backup [--dir D] [--keep N] | verify FILE | restore FILE --to DIR [--force]', err: 'Error' },
  pt: { saved: 'Backup salvo', dbs: 'bancos', verifyOk: 'O backup está íntegro: cada banco confere com o checksum e com o conteúdo.', verifyBad: 'PROBLEMA: este backup não confere com o que foi salvo. Não use.', restored: 'Restaurado em', old: 'Os arquivos anteriores foram guardados em', same: 'Cada banco restaurado foi conferido com o backup (integridade e conteúdo): idêntico.', diff: 'PROBLEMA: um banco restaurado não confere com o backup.', key: 'ATENÇÃO: a chave de criptografia configurada nesta máquina não é a usada quando o backup foi feito. CPF/EIN, tokens do banco e segredos do 2FA não vão abrir até você usar a FLUXO_ENCRYPTION_KEY original.', usage: 'Uso: backupCli.js backup [--dir D] [--keep N] | verify ARQUIVO | restore ARQUIVO --to PASTA [--force]', err: 'Erro' },
  es: { saved: 'Copia guardada', dbs: 'bases de datos', verifyOk: 'La copia está íntegra: cada base coincide con su checksum y su contenido.', verifyBad: 'PROBLEMA: esta copia no coincide con lo guardado. No la use.', restored: 'Restaurado en', old: 'Los archivos anteriores se guardaron en', same: 'Cada base restaurada se comparó con la copia (integridad y contenido): idéntica.', diff: 'PROBLEMA: una base restaurada no coincide con la copia.', key: 'AVISO: la clave de cifrado de esta máquina no es la usada al hacer la copia. Los números fiscales, tokens del banco y secretos del 2FA no se abrirán hasta usar la FLUXO_ENCRYPTION_KEY original.', usage: 'Uso: backupCli.js backup [--dir D] [--keep N] | verify ARCHIVO | restore ARCHIVO --to CARPETA [--force]', err: 'Error' },
}[['pt', 'es'].includes(lang) ? lang : 'en'];

const args = process.argv.slice(2), cmd = args[0];
const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
const file = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
try {
  if (cmd === 'backup') {
    const bk = await import('./backup.js'); // só o backup abre os bancos do servidor
    const r = bk.runBackup({ dir: opt('--dir') ? path.resolve(opt('--dir')) : undefined, keep: opt('--keep') ? Number(opt('--keep')) : undefined });
    console.log(`${M.saved}: ${r.file} (${r.bytes} bytes, ${r.manifest.files.length} ${M.dbs})`);
  } else if (cmd === 'verify' && file) {
    const v = core.verifyBackup(path.resolve(file));
    for (const f of v.files) console.log(`${f.ok ? 'OK ' : 'ERRO'} ${f.name} ${JSON.stringify(f.counts)}`);
    console.log(v.ok ? M.verifyOk : M.verifyBad);
    if (!v.keyMatches) console.log(M.key);
    process.exitCode = v.ok ? 0 : 2;
  } else if (cmd === 'restore' && file && opt('--to')) {
    const r = core.restoreBackup(path.resolve(file), path.resolve(opt('--to')), { force: args.includes('--force') });
    for (const x of r.report) console.log(`${x.ok ? 'OK ' : 'ERRO'} ${x.file} ${JSON.stringify(x.counts)}`);
    console.log(`${M.restored} ${path.resolve(opt('--to'))}`);
    if (r.savedTo) console.log(`${M.old} ${r.savedTo}`);
    console.log(r.ok ? M.same : M.diff);
    if (!r.keyMatches) console.log(M.key);
    process.exitCode = r.ok ? 0 : 2;
  } else { console.log(M.usage); process.exitCode = 1; }
} catch (e) { console.error(`${M.err}: ${e.message}`); process.exitCode = 1; }
