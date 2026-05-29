# =============================================================================
# Update-SharePointMetadata.ps1
#
# Reads metadata from an Excel spreadsheet and writes it to matching files
# in a SharePoint document library, matched by document number and version.
#
# Prerequisites:
#   Install-Module PnP.PowerShell -Scope CurrentUser
#   Install-Module ImportExcel -Scope CurrentUser
#
# Usage:
#   .\Update-SharePointMetadata.ps1
# =============================================================================

# --- CONFIGURATION -----------------------------------------------------------
$SiteUrl        = "https://yourtenant.sharepoint.com/sites/yoursite"
$LibraryName    = "Your Library Name"
$ExcelPath      = "C:\Path\To\YourSpreadsheet.xlsx"
$LogPath        = "C:\Path\To\update-log_$(Get-Date -Format 'yyyyMMdd_HHmmss').csv"
# -----------------------------------------------------------------------------

#region Helper

function Write-Log {
    param(
        [string]$FileName,
        [string]$Status,       # SUCCESS or ERROR
        [string]$Message
    )
    $entry = [PSCustomObject]@{
        Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        FileName  = $FileName
        Status    = $Status
        Message   = $Message
    }
    $entry | Export-Csv -Path $LogPath -Append -NoTypeInformation
    $colour = if ($Status -eq "SUCCESS") { "Green" } else { "Red" }
    Write-Host "[$Status] $FileName - $Message" -ForegroundColor $colour
}

function Get-DocAndVersion {
    # Extracts document number and version from a filename like:
    #   "Some name_114_1.pdf"  ->  DocNumber=114, Version=1
    param([string]$FileName)
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
    if ($baseName -match '_(\d+)_(\d+)$') {
        return @{ DocNumber = [int]$Matches[1]; Version = [int]$Matches[2] }
    }
    return $null
}

#endregion

# --- LOAD EXCEL DATA ---------------------------------------------------------
Write-Host "Loading spreadsheet: $ExcelPath" -ForegroundColor Cyan

try {
    $rows = Import-Excel -Path $ExcelPath -WorksheetName "Sheet1"  # adjust sheet name if needed
}
catch {
    Write-Error "Failed to load Excel file: $_"
    exit 1
}

# Build a lookup hashtable keyed on "DocNumber|Version" for O(1) lookups
$lookup = @{}
foreach ($row in $rows) {
    $key = "$($row.'DocNumber')|$($row.'Version')"   # adjust column header names to match your spreadsheet
    $lookup[$key] = $row
}

Write-Host "Loaded $($lookup.Count) rows from spreadsheet." -ForegroundColor Cyan

# --- CONNECT TO SHAREPOINT ---------------------------------------------------
Write-Host "Connecting to SharePoint: $SiteUrl" -ForegroundColor Cyan

try {
    Connect-PnPOnline -Url $SiteUrl -Interactive   # use -Interactive for MFA; swap for -ClientId/-Thumbprint for automation
}
catch {
    Write-Error "Failed to connect to SharePoint: $_"
    exit 1
}

# --- RETRIEVE ALL FILES FROM LIBRARY -----------------------------------------
Write-Host "Retrieving all files from library: $LibraryName" -ForegroundColor Cyan

try {
    $allItems = Get-PnPListItem -List $LibraryName -PageSize 500 -Fields "FileLeafRef","FileRef","ID"
}
catch {
    Write-Error "Failed to retrieve library items: $_"
    Disconnect-PnPOnline
    exit 1
}

Write-Host "Found $($allItems.Count) items in library." -ForegroundColor Cyan

# --- PROCESS EACH FILE -------------------------------------------------------
$successCount = 0
$errorCount   = 0
$skippedCount = 0

foreach ($item in $allItems) {

    $fileName = $item["FileLeafRef"]

    # Parse doc number and version from the filename
    $parsed = Get-DocAndVersion -FileName $fileName
    if (-not $parsed) {
        Write-Log -FileName $fileName -Status "SKIPPED" -Message "Filename does not match expected pattern (e.g. Name_114_1.pdf)"
        $skippedCount++
        continue
    }

    $key = "$($parsed.DocNumber)|$($parsed.Version)"

    # Look up matching row in spreadsheet
    if (-not $lookup.ContainsKey($key)) {
        Write-Log -FileName $fileName -Status "SKIPPED" -Message "No matching row found in spreadsheet for DocNumber=$($parsed.DocNumber), Version=$($parsed.Version)"
        $skippedCount++
        continue
    }

    $data = $lookup[$key]

    # Build the field values to update
    # Contributor is a Person/Group lookup field — PnP accepts a UPN (email) or user ID
    try {
        $contributorUser = Resolve-PnPUser -Identity $data.'Contributor'   # expects a UPN / email in your spreadsheet
        $contributorValue = $contributorUser.Id
    }
    catch {
        Write-Log -FileName $fileName -Status "ERROR" -Message "Could not resolve Contributor user '$($data.'Contributor')': $_"
        $errorCount++
        continue
    }

    $fieldValues = @{
        "Contributor"         = $contributorValue          # Person lookup — pass the resolved user ID
        "Internal"            = $data.'Internal'           # Choice field — value must match a valid choice exactly
        "KnowHowType"         = $data.'KnowHowType'        # Choice field
        "AlternateAuthors"    = $data.'AlternateAuthors'   # Single line of text
        "KeywordsAndConcepts" = $data.'KeywordsAndConcepts'# Single line of text
        "Comments"            = $data.'Comments'           # Single line of text
    }

    # Write to SharePoint
    try {
        Set-PnPListItem -List $LibraryName -Identity $item.Id -Values $fieldValues | Out-Null
        Write-Log -FileName $fileName -Status "SUCCESS" -Message "Updated DocNumber=$($parsed.DocNumber), Version=$($parsed.Version)"
        $successCount++
    }
    catch {
        Write-Log -FileName $fileName -Status "ERROR" -Message "Set-PnPListItem failed: $_"
        $errorCount++
    }
}

# --- SUMMARY -----------------------------------------------------------------
Disconnect-PnPOnline

Write-Host ""
Write-Host "=== COMPLETE ===" -ForegroundColor Cyan
Write-Host "  Success : $successCount"
Write-Host "  Errors  : $errorCount"
Write-Host "  Skipped : $skippedCount"
Write-Host "  Log     : $LogPath"
