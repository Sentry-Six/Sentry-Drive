# Signs one Windows file with Microsoft Artifact Signing. Tauri calls this for
# every binary it signs (bundle.windows.signCommand, set by the release
# workflow), with the file path as the only argument.
#
# Needs an Azure login already in the session (azure/login with OIDC in CI)
# and the TrustedSigning PowerShell module, plus these environment variables:
#   ARTIFACT_SIGNING_ENDPOINT  e.g. https://eus.codesigning.azure.net
#   ARTIFACT_SIGNING_ACCOUNT   the Artifact Signing account name
#   ARTIFACT_SIGNING_PROFILE   the certificate profile name
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
foreach ($name in 'ARTIFACT_SIGNING_ENDPOINT', 'ARTIFACT_SIGNING_ACCOUNT', 'ARTIFACT_SIGNING_PROFILE') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set" }
}
if (-not (Test-Path -LiteralPath $Path)) { throw "No file to sign at $Path" }

Invoke-TrustedSigning `
  -Endpoint $env:ARTIFACT_SIGNING_ENDPOINT `
  -CodeSigningAccountName $env:ARTIFACT_SIGNING_ACCOUNT `
  -CertificateProfileName $env:ARTIFACT_SIGNING_PROFILE `
  -FileDigest SHA256 `
  -TimestampRfc3161 'http://timestamp.acs.microsoft.com' `
  -TimestampDigest SHA256 `
  -Files $Path

# Fail the build rather than ship a file that only looks signed.
$sig = Get-AuthenticodeSignature -LiteralPath $Path
if ($sig.Status -ne 'Valid') { throw "Signature on $Path is $($sig.Status): $($sig.StatusMessage)" }
Write-Host "Signed $(Split-Path -Leaf $Path) as $($sig.SignerCertificate.Subject)"
