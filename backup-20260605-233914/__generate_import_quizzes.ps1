Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = "E:\Edgeducate\Software\Quiz\Quiz"
$xlsxPath = Join-Path $root "Import.xlsx"
$quizRoot = Join-Path $root "quizzes"

function Get-SharedStrings($zip) {
  $entry = $zip.GetEntry("xl/sharedStrings.xml")
  if (-not $entry) { return @() }
  $stream = $entry.Open()
  try {
    $reader = New-Object System.IO.StreamReader($stream)
    $xmlText = $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
  [xml]$xml = $xmlText
  $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
  $ns.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
  $items = @()
  $siNodes = $xml.SelectNodes("//x:sst/x:si", $ns)
  foreach ($si in $siNodes) {
    $tNodes = $si.SelectNodes(".//x:t", $ns)
    if ($tNodes.Count -eq 0) {
      $items += ""
      continue
    }
    $text = (($tNodes | ForEach-Object { $_.'#text' }) -join "")
    $items += $text
  }
  return $items
}

function Get-CellValue($cell, $sharedStrings) {
  if (-not $cell) { return "" }
  $vNode = $cell.v
  if (-not $vNode) { return "" }
  $raw = [string]$vNode
  if ([string]::IsNullOrWhiteSpace($raw)) { return "" }
  if ($cell.t -eq "s") {
    $idx = 0
    if ([int]::TryParse($raw, [ref]$idx) -and $idx -ge 0 -and $idx -lt $sharedStrings.Count) {
      return [string]$sharedStrings[$idx]
    }
  }
  return $raw
}

function Split-Options($text) {
  if ([string]::IsNullOrWhiteSpace($text) -or $text -eq "N/A") { return @() }
  return @($text -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
}

function Count-Emoji($text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return 0 }
  $emojis = @("??","?","??","??","??","??","??")
  $count = 0
  foreach ($e in $emojis) {
    $count += ([regex]::Matches($text, [regex]::Escape($e))).Count
  }
  return $count
}

function Get-FirstNumber($text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  $m = [regex]::Match($text, "(?<!\.)\b\d+\b")
  if ($m.Success) { return [int]$m.Value }
  return $null
}

function Compute-Answer($row) {
  $q = [string]$row.Question
  $qt = ([string]$row.QuestionType).ToLowerInvariant()
  $options = @($row.Options)

  if ($q -match "What comes next\?\s*(\d+)\s*,\s*(\d+)\s*,\s*__") {
    return [string](([int]$Matches[2]) + 1)
  }

  if ($q -match "Which number is\s*(\d+)") { return $Matches[1] }
  if ($q -match "Select the number\s*(\d+)") { return $Matches[1] }

  if ($q -match "means none|no apples|empty box|no fish|no balloons|no cars|no dogs") {
    return "0"
  }
  if ($q -match "means one") { return "1" }

  if ($qt -match "multi select" -or $q -match "Select all") {
    if ($q -match "0") {
      $hits = @($options | Where-Object { $_ -eq "0" })
      if ($hits.Count -gt 0) { return ($hits -join ", ") }
    }
    if ($q -match "1") {
      $hits = @($options | Where-Object { $_ -eq "1" })
      if ($hits.Count -gt 0) { return ($hits -join ", ") }
    }
    $nums = @($options | Where-Object { $_ -match "^\d+$" })
    if ($nums.Count -gt 0) { return ($nums -join ", ") }
  }

  if ($q -match "Which group has 0 objects") {
    $candidate = $options | Where-Object { $_ -match "Empty|None|No" } | Select-Object -First 1
    if ($candidate) { return [string]$candidate }
    $candidate = $options | Where-Object { (Count-Emoji $_) -eq 0 } | Select-Object -First 1
    if ($candidate) { return [string]$candidate }
  }

  if ($q -match "Which group has 1 object") {
    $candidate = $options | Where-Object { (Count-Emoji $_) -eq 1 } | Select-Object -First 1
    if ($candidate) { return [string]$candidate }
  }

  if ($q -match "How many|Which number matches") {
    $cnt = Count-Emoji $q
    if ($cnt -gt 0) { return [string]$cnt }
    $n = Get-FirstNumber $q
    if ($null -ne $n) { return [string]$n }
  }

  if ($qt -match "tracing|draw|writing" -or $q -match "Trace|Draw") {
    $n = Get-FirstNumber $q
    if ($null -ne $n) { return [string]$n }
  }

  if ($qt -match "multiple choice") {
    if ($q -match "Which of these is a number") {
      $num = $options | Where-Object { $_ -match "^\d+$" } | Select-Object -First 1
      if ($num) { return [string]$num }
    }
    $num = $options | Where-Object { $_ -match "^\d+$" } | Select-Object -First 1
    if ($num) { return [string]$num }
  }

  $n = Get-FirstNumber $q
  if ($null -ne $n) { return [string]$n }
  if ($options.Count -gt 0) { return [string]$options[0] }
  return ""
}

function Build-Solution($question, $answer) {
  if ([string]::IsNullOrWhiteSpace($answer)) {
    return "Read the question carefully and use the lesson concept to complete it."
  }
  if ($question -match "Select all") {
    return "Select every correct choice. The correct selections are: $answer."
  }
  if ($question -match "What comes next") {
    return "Continue the counting pattern by 1. The next number is $answer."
  }
  if ($question -match "How many|Which number matches") {
    return "Count the objects shown and match that quantity. The correct answer is $answer."
  }
  if ($question -match "Trace|Draw") {
    return "The target numeral is $answer. Trace or draw it carefully."
  }
  return "The correct answer is $answer based on the question prompt."
}

function Slugify($text) {
  $slug = ([string]$text).ToLowerInvariant() -replace "[^a-z0-9]+", "-"
  $slug = $slug.Trim('-')
  if ([string]::IsNullOrWhiteSpace($slug)) { $slug = "module" }
  return $slug
}

$zip = [System.IO.Compression.ZipFile]::OpenRead($xlsxPath)
try {
  $shared = Get-SharedStrings $zip
  $sheetEntry = $zip.GetEntry("xl/worksheets/sheet1.xml")
  if (-not $sheetEntry) { throw "sheet1.xml not found" }

  $stream = $sheetEntry.Open()
  try {
    $reader = New-Object System.IO.StreamReader($stream)
    $sheetXmlText = $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }

  [xml]$sheetXml = $sheetXmlText
  $ns = New-Object System.Xml.XmlNamespaceManager($sheetXml.NameTable)
  $ns.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")

  $rows = @()
  $rowNodes = $sheetXml.SelectNodes("//x:sheetData/x:row", $ns)
  $headers = @{}

  foreach ($rowNode in $rowNodes) {
    $r = [int]$rowNode.r
    $cells = @{}
    foreach ($c in $rowNode.c) {
      $ref = [string]$c.r
      $col = ($ref -replace "\d", "")
      $cells[$col] = Get-CellValue $c $shared
    }

    if ($r -eq 1) {
      foreach ($k in $cells.Keys) { $headers[$k] = $cells[$k] }
      continue
    }

    $row = [PSCustomObject]@{
      Grade = [string]$cells['A']
      Module = [string]$cells['B']
      LessonPart = [string]$cells['C']
      LessonName = [string]$cells['D']
      Category = [string]$cells['E']
      Subcategory = [string]$cells['F']
      QNo = [int]([string]$cells['G'])
      QuestionType = [string]$cells['H']
      Question = [string]$cells['I']
      OptionsRaw = [string]$cells['J']
      LearningOutcome = [string]$cells['K']
      Options = @(Split-Options ([string]$cells['J']))
    }
    if (-not [string]::IsNullOrWhiteSpace($row.Grade) -and -not [string]::IsNullOrWhiteSpace($row.LessonPart) -and -not [string]::IsNullOrWhiteSpace($row.Question)) {
      $rows += $row
    }
  }

  if ($rows.Count -eq 0) { throw "No data rows found in Import.xlsx" }

  $indexPath = Join-Path $quizRoot "index.json"
  $indexObj = Get-Content -Path $indexPath -Raw | ConvertFrom-Json

  $groups = $rows | Group-Object Grade
  foreach ($g in $groups) {
    $grade = [string]$g.Name
    $gradeFolder = ($grade -replace "[^A-Za-z0-9]", "").Trim()
    if ([string]::IsNullOrWhiteSpace($gradeFolder)) { $gradeFolder = "General" }
    $gradeDir = Join-Path $quizRoot $gradeFolder
    if (-not (Test-Path $gradeDir)) {
      New-Item -ItemType Directory -Path $gradeDir | Out-Null
    }

    $lessonGroups = $g.Group | Group-Object LessonPart
    $quizEntries = @()

    foreach ($lg in $lessonGroups) {
      $lessonPart = [string]$lg.Name
      $rowsForLesson = @($lg.Group | Sort-Object QNo)
      $lessonName = [string]$rowsForLesson[0].LessonName
      $moduleName = [string]$rowsForLesson[0].Module

      $partToken = ($lessonPart -replace "[^0-9A-Za-z]", "-").Trim('-').ToLowerInvariant()
      if ([string]::IsNullOrWhiteSpace($partToken)) { $partToken = Slugify $lessonPart }
      $fileName = "lesson-part-$partToken.json"
      $relativeFile = "$gradeFolder/$fileName"
      $outPath = Join-Path $gradeDir $fileName

      $title = "$lessonPart - $lessonName"
      $description = "Auto-generated from Import.xlsx for $grade ($moduleName)."

      $questions = @()
      foreach ($r in $rowsForLesson) {
        $ans = Compute-Answer $r
        $sol = Build-Solution $r.Question $ans
        $opts = @($r.Options)
        if ($opts.Count -eq 0) { $opts = @("", "", "", "") }

        $questionObj = [ordered]@{
          question = [string]$r.Question
          resultType = "short-answer"
          options = $opts
          correctAnswer = [string]$ans
          notesAttachments = @()
          image = ""
          solution = [string]$sol
          solutionAttachments = @()
        }
        $questions += [PSCustomObject]$questionObj
      }

      $quizId = Slugify "$grade-$lessonPart-$lessonName"
      $quizObj = [ordered]@{
        id = $quizId
        title = $title
        description = $description
        settings = [ordered]@{
          questionOrder = "ordered"
          questionLimit = $questions.Count
        }
        category = $grade
        questions = $questions
      }

      $json = $quizObj | ConvertTo-Json -Depth 8
      [System.IO.File]::WriteAllText($outPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

      $quizEntries += [PSCustomObject]@{
        title = $title
        file = $relativeFile
      }
    }

    $existing = @($indexObj.categories | Where-Object { $_.name -eq $grade })
    if ($existing.Count -gt 0) {
      $existing[0].quizzes = $quizEntries
    } else {
      $indexObj.categories += [PSCustomObject]@{
        name = $grade
        quizzes = $quizEntries
      }
    }
  }

  $indexJson = $indexObj | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($indexPath, $indexJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

  "Generated modules:"
  Get-ChildItem -Path $quizRoot -Recurse -File | Where-Object { $_.Name -like "lesson-part-*.json" } | Select-Object -ExpandProperty FullName
} finally {
  $zip.Dispose()
}