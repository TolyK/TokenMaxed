# TokenMaxed PreToolUse gate — Windows wrapper (the VS Code extension looks for
# PreToolUse.ps1). Forwards stdin/stdout to the extensionless CJS bundle.
$input | & node "$PSScriptRoot\PreToolUse"
