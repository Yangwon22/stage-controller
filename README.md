# Stage Controller v1.4 (UE 5.7)

iPad / iPhone에서 레벨 안의 모든 Post Process Volume과 nDisplay(NDC, ICVFX 카메라 등)를 UE 디테일 패널처럼 제어합니다.

```
iPad / iPhone Safari ──WebSocket──> Bridge (이 폴더, PC) ──HTTP──> UE 5.7 Remote Control (127.0.0.1:30010)
```

## 실행
1. UE 5.7 실행 → 콘솔(Cmd)에 `WebControl.StartServer`
   - 매번 입력하지 않으려면 Project Settings > Remote Control에서 웹 서버 자동 시작 옵션을 켜세요.
2. `start.bat` 더블클릭 (처음 한 번은 자동으로 설치)
3. iPad/iPhone Safari에서 콘솔에 표시된 주소 접속 → PIN `1234`
4. Safari 공유 > 홈 화면에 추가 → 앱처럼 실행

UE를 나중에 켜거나 재시작해도 Bridge가 3초 안에 자동으로 다시 연결하고 레벨을 다시 스캔합니다.
레벨을 바꾸거나 액터를 추가했다면 Outliner의 **Rescan**을 누르세요.

## 기능
- **Outliner (UE식)**: 레벨의 모든 액터를 UE Outliner와 같은 폴더 구조·액터 라벨·이름순으로 표시
  - ▸를 누르면 그 액터의 모든 컴포넌트를 불러옵니다 (nDisplay는 처음부터 펼쳐짐)
  - Search Outliner: 라벨 또는 타입으로 검색
  - 프로퍼티에 있는 컴포넌트/서브오브젝트 참조(→ 표시)를 누르면 바로 열림
- **자동 탐색**: PPV, nDisplay 루트 액터와 설정 서브오브젝트(CurrentConfigData)는 아이콘으로 강조
- **전체 프로퍼티**: 엔진이 Remote Control로 알려주는 구조 그대로 UI 자동 생성 (항목을 손으로 등록하지 않음)
- **Unreal과 같은 이름**: 설치된 UE 5.7 엔진 헤더를 시작할 때 읽어서 Details 패널과 같은 표시 이름, 카테고리, 슬라이더 범위, Enum 드롭다운, 표시/숨김 규칙을 적용
  - 엔진 위치는 자동으로 찾습니다(레지스트리, `C:\Program Files\Epic Games\UE_5.7` 등). 못 찾으면 콘솔에 표시되며 `config.json`의 `engineDir`에 경로를 넣으면 됩니다.
  - 첫 실행 때 헤더를 읽느라 몇 초 걸리고, 이후에는 `schema-cache.json`으로 바로 뜹니다.
  - Outliner는 UE Outliner와 같은 액터 라벨로 표시
- **Transform (액터)**: 액터를 선택하면 Details 맨 위에 Location / Rotation / Scale (루트 컴포넌트 기준, UE Details와 동일)
  - 드래그 속도: Location 1cm/px, Rotation 0.5°/px, Scale 0.01/px (`Fine` = 10배 정밀)
  - 엔진 함수 K2_SetRelativeLocation / K2_SetRelativeRotation / SetRelativeScale3D로 적용, 트랜잭션 기록
- **액터 + 컴포넌트 속성 (UE Details와 동일)**: 액터를 선택하면 루트 컴포넌트와 액터가 노출한 컴포넌트(라이트, 스태틱 메시 등)의 속성이 함께 표시
  - 라이트: Intensity, Light Color, Intensity Units, Attenuation Radius, Source Radius, Soft Source Radius, Source Length 등 Light 카테고리 전체
  - 엔진이 직접 쓰기를 거부하는 속성은 Set 함수(예: `SetIntensity`)로 자동 전환해서 적용 (엔진 헤더에서 함수와 인자 이름을 읽음)
  - UI 범위 밖에 있는 값(예: Intensity 5000, 슬라이더 최대 20)은 드래그해도 슬라이더 범위로 잘리지 않음
- **시작 화면**: 흑백 모션그래픽 (LED 월 + 카메라 프러스텀), 동작 줄이기 설정 시 정지 화면
- **UE식 조작**
  - 숫자: 좌우 드래그로 조절, 탭하면 직접 입력. `Fine` = 10배 정밀 조절
  - 벡터·컬러: X/Y/Z/W(R/G/B/A) 채널별 필드
  - 오버라이드 체크박스: 값을 바꾸면 자동으로 켜짐 (편의 기능. UE 에디터는 체크박스를 먼저 켜야 편집 가능)
  - ↺ 버튼: 그 항목을 세션 시작 값으로 복원 (오버라이드 상태까지)
- **Search / Modified**: 이름 검색, 바뀐 항목만 보기
- **Revert All**: 오브젝트 전체를 세션 시작 상태로 복원
- **Snapshots**: 현재 룩 저장 / 적용 (PPV는 켜진 오버라이드 전체를 저장, `snapshots.json`)
- **Lock**: 테이크 중 모든 기기 조작 잠금
- 여러 기기 동시 접속 시 실시간 동기화, 에디터에서 직접 바꾼 값도 2초 안에 반영
- 모든 변경은 트랜잭션으로 기록 → 에디터 Ctrl+Z 가능, Multi-User 전파 경로 사용
- 변경 기록: `changes.log`

## 설정 (`config.json`)
| 항목 | 설명 |
| --- | --- |
| `pin` | 접속 PIN |
| `port` | iPad 접속 포트 (기본 8080) |
| `ue.port` | UE Remote Control HTTP 포트 (기본 30010) |
| `transactionMode` | `always`: 드래그 중에도 트랜잭션 (Multi-User로 실시간 전파) / `onRelease`: 손 뗄 때만 (Undo 기록이 적음) |
| `manualObjects` | 자동 탐색이 안 될 때 직접 넣을 오브젝트 경로 목록 |
| `engineDir` | UE 설치 폴더 (예: `C:\\Program Files\\Epic Games\\UE_5.7`). 비우면 자동 탐색 |

## 문제 해결
- **Unreal 표시등이 빨간색**: UE가 꺼져 있거나 웹 서버가 안 켜짐 → `WebControl.StartServer`, 브라우저로 `http://127.0.0.1:30010/remote/info` 확인
- **Outliner가 비어 있음**: Outliner 하단 메시지 확인. "Actor listing unavailable"이면 `node discover.js` 실행 후 `discover-output.json`을 보내주세요. 임시로는 `manualObjects`에 경로를 넣으면 됩니다.
- **iPad에서 접속 불가**: 같은 Wi-Fi인지, Windows 방화벽에서 Node.js 허용(개인 네트워크)인지 확인
- **Details가 안 뜸**: 화면에 표시되는 메시지와 Bridge 콘솔의 `OPEN FAILED` / `TRANSFORM FAILED` 줄을 보내주세요.
- **Write failed 메시지**: 엔진이 해당 항목 쓰기를 거부한 경우입니다. 메시지와 `changes.log`를 보내주세요.

## 검증 범위
- 모의 UE 서버로 자동 탐색, 중첩 쓰기, 오버라이드 자동 처리, 복원, 스냅샷, 잠금을 테스트했습니다.
- 실제 UE 5.7에서 확인됨: PPV 노출·화이트밸런스 쓰기, 엔진 자동 연결, 액터 자동 탐색. 액터 라벨·폴더 경로 읽기(GetActorLabel / GetFolderPath)와 nDisplay 중첩 구조 쓰기는 실기 확인이 필요합니다. 라벨·폴더를 못 읽으면 오브젝트 이름으로, 폴더 없이 표시됩니다.
- 액터가 수천 개인 레벨은 첫 스캔에 시간이 걸릴 수 있습니다 (진행 상황이 Outliner 하단에 표시).
- 렌더 노드 전파(Multi-User)는 스테이지 클러스터에서 검증해야 합니다.
- 이름·카테고리·Enum은 엔진 헤더 기준입니다. 헤더 파서는 UE 스타일 테스트 헤더로만 검증했으므로, 실제 헤더에서 이름이 다르게 보이는 항목이 있으면 알려주세요.
- 헤더에 없는 프로퍼티(Blueprint 변수 등)는 UE 자동 이름 규칙(NameToDisplayString)으로 표시합니다.
