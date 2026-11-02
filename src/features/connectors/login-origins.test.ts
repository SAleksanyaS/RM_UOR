import { expect, it } from 'vitest';
import { privateProfileSchema } from './contracts';
import { checkedUrl, loginUrlAllowed } from './transport';

const profile = privateProfileSchema.parse({ allowedOrigins: ['https://oko-qs.sigma.sbrf.ru'], loginAllowedOrigins:['https://idp02.auth.sigma.sbrf.ru','https://alt.idp02.auth.sigma.sbrf.ru','https://swwidgetui.sberbank.ru','https://swwidgetapi.sberbank.ru','https://swwidget-listener.sberbank.ru','https://visor.sberbank.ru'], timeoutMs: 5000 });

it('lets the manual login window load the report, the corporate SSO and its widgets', () => {
  // The OKO sheet itself loads these origins; blocking them renders ERR_BLOCKED_BY_CLIENT
  // inside the login window and the operator cannot sign in.
  for (const url of [
    'https://oko-qs.sigma.sbrf.ru/prom/sense/app/x/sheet',
    'https://idp02.auth.sigma.sbrf.ru/adfs/ls/',
    'https://alt.idp02.auth.sigma.sbrf.ru/adfs/ls/',
    'https://swwidgetui.sberbank.ru/frame',
    'https://swwidgetapi.sberbank.ru/api',
    'https://swwidget-listener.sberbank.ru/listen',
    'https://visor.sberbank.ru/page',
  ]) expect(loginUrlAllowed(url, profile), url).toBe(true);
});

it('still refuses foreign hosts, plain HTTP and credentials in the URL', () => {
  expect(loginUrlAllowed('https://evil.example/report', profile)).toBe(false);
  expect(loginUrlAllowed('https://sigma.sbrf.ru.evil.example/', profile)).toBe(false);
  expect(loginUrlAllowed('http://idp02.auth.sigma.sbrf.ru/adfs/ls/', profile)).toBe(false);
  expect(loginUrlAllowed('https://user:pass@idp02.auth.sigma.sbrf.ru/', profile)).toBe(false);
});

it('keeps downloads and recorded steps bound to the exact report origin', () => {
  expect(() => checkedUrl('https://idp02.auth.sigma.sbrf.ru/adfs/ls/', profile)).toThrow();
  expect(checkedUrl('https://oko-qs.sigma.sbrf.ru/export', profile).origin).toBe('https://oko-qs.sigma.sbrf.ru');
});

it('does not trust corporate suffixes or invalid HTTP and allows only exact configured login origins',()=>{
 const profile=privateProfileSchema.parse({allowedOrigins:['https://report.example'],loginAllowedOrigins:['https://sso.example:8443']});
 expect(loginUrlAllowed('https://arbitrary.sberbank.ru',profile)).toBe(false);
 expect(loginUrlAllowed('https://sso.example:8443/login',profile)).toBe(true);
 expect(loginUrlAllowed('https://sso.example/login',profile)).toBe(false);
 expect(loginUrlAllowed('https://nested.sso.example:8443/login',profile)).toBe(false);
 expect(loginUrlAllowed('http://report.example',{...profile,allowedOrigins:['http://report.example']})).toBe(false);
});
