#define AppPublisher "timeline"
#define AppURL "https://github.com/shihuaidexianyu/timeline"
#define AppExeName "timeline.exe"
#ifndef SourceDir
  #error SourceDir must be passed by scripts/build-installer.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be passed by scripts/build-installer.ps1
#endif

[Setup]
AppId={{6D97360A-42B6-44C5-A923-1E6F03C1F8AA}
AppName=Timeline
AppVerName=Timeline
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
DefaultDirName={localappdata}\Programs\Timeline
DefaultGroupName=Timeline
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=timeline-setup
SetupIconFile=..\apps\timeline-backend\assets\timeline.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Dirs]
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\config"; Flags: uninsneveruninstall

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "config\timeline.toml,data\*"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\config\timeline.toml"; DestDir: "{app}\config"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{group}\Timeline"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\Timeline"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,Timeline}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\web-ui"
Type: filesandordirs; Name: "{app}\browser-extension"
Type: files; Name: "{app}\timeline.exe"
