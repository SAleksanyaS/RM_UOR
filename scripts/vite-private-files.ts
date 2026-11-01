/** Vite's default denies plus project-private paths; no local configuration reads. */
export const privateDevServerDeny = [
  '.env', '.env.*', '*.{crt,pem}', '**/.git/**',
  '**/.runtime/**', '**/config/*.local.json', '**/{credentials,secrets,curators}*.json', '*.{key,pfx,p12,bundle}', '**/.git',
];
