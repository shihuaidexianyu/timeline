#define AppPublisher "timeline"
#define AppURL "https://github.com/shihuaidexianyu/timeline"
#define AppExeName "timeline.exe"
#ifndef AppVersion
  #error AppVersion must be passed by scripts/build-installer.ps1
#endif
#ifndef SourceDir
  #error SourceDir must be passed by scripts/build-installer.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be passed by scripts/build-installer.ps1
#endif

[Setup]
AppId={{6D97360A-42B6-44C5-A923-1E6F03C1F8AA}
AppName=Timeline
AppVersion={#AppVersion}
AppVerName=Timeline {#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Timeline
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
#ifdef EnableSigning
SignTool=signtool
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

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

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and (not UninstallSilent) then
  begin
    if MsgBox('是否同时删除 Timeline 的本地配置与活动数据？' + #13#10 +
      '默认保留这些数据，以便重新安装后继续使用。', mbConfirmation,
      MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(ExpandConstant('{app}\data'), True, True, True);
      DelTree(ExpandConstant('{app}\config'), True, True, True);
    end;
  end;
end;
