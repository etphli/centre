import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export function useSystemCertificateAuthorities() {
  setDefaultCACertificates([...getCACertificates('default'), ...getCACertificates('system')]);
}
