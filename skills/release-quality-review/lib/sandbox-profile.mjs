const NETWORK_SYSTEM_SERVICES = [
  'com.apple.cfprefsd.agent',
  'com.apple.cfprefsd.daemon',
  'com.apple.system.DirectoryService.libinfo_v1',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.trustd',
  'com.apple.trustd.agent',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.SCNetworkReachability',
  'com.apple.securityd.xpc',
  'com.apple.SecurityServer',
  'com.apple.system.notification_center',
];

export function buildCandidateSandboxProfile({ readRoots, writeRoots, allowNetwork }) {
  const quote = value => JSON.stringify(value);
  const readSubpaths = readRoots.filter(root => root !== '/');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl*)',
    ...(allowNetwork ? [
      '(allow network*)',
      `(allow mach-lookup ${NETWORK_SYSTEM_SERVICES.map(name => `(global-name ${quote(name)})`).join(' ')})`,
      '(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))',
    ] : []),
    '(allow dynamic-code-generation)',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${readSubpaths.map(root => `(subpath ${quote(root)})`).join(' ')})`,
    `(allow file-write* ${writeRoots.map(root => `(subpath ${quote(root)})`).join(' ')})`,
  ].join(' ');
}
