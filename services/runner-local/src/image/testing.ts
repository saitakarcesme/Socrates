import { issueAdmittedSandboxImage } from "./capability";

import type { AdmittedSandboxImage } from "./capability";

export function createAdmittedImageForTesting(
  reference: string,
  architecture: "amd64" | "arm64",
): AdmittedSandboxImage {
  const digest = reference.slice(reference.lastIndexOf("@") + 1);
  return issueAdmittedSandboxImage({
    reference,
    digest,
    architecture,
    runtime: {
      executable: "/usr/local/bin/node",
      arguments: ["/opt/socrates/task-runtime.mjs"],
    },
    profileProbe: {
      executable: "/usr/local/bin/node",
      arguments: [
        "-e",
        [
          "const fs=require('node:fs')",
          "const label=fs.readFileSync('/proc/self/attr/current','utf8').trim()",
          "const uidMap=fs.readFileSync('/proc/self/uid_map','utf8').trim()",
          "const status=fs.readFileSync('/proc/self/status','utf8')",
          "const capabilities=Object.fromEntries(status.split('\\n').filter(line=>/^Cap(?:Inh|Prm|Eff|Bnd|Amb):/.test(line)).map(line=>{const [name,value]=line.split(':');return [name,value.trim()]}))",
          "let denied=false",
          "try{fs.writeFileSync('/tmp/socrates-lsm-probe','probe')}catch(error){denied=error?.code==='EACCES'}",
          "process.stdout.write(JSON.stringify({label,denied,uidMap,capabilities}))",
        ].join(";"),
      ],
    },
  });
}
