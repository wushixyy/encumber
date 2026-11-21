// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Encumber 预算锁
/// @notice Agent 团队的链上项目预算：每个项目的预算分成「已花 / 已预占 / 可用」三态，由合约实时维护。
///         - Agent 调用按量计费的服务前锁定一笔付款承诺：绑定指定供应商、订单号和截止时间
///         - 截止前只有该供应商能按实际用量结算（不超过上限、只能一次），Agent 掉线、财务取消都不影响供应商收款
///         - 结算后剩余自动释放回项目；过期未结算的承诺任何人都能释放
///         - 财务调拨只能调走「未花且未预占」的部分，已花的留在原项目，已预占的谁也挪不走
///         - 付款与调拨同时发生时按链上先后顺序判定，被拒的一方留下带原因的拦截记录（不 revert）
contract Encumber {
    // ---------------------------------------------------------------------
    // 类型
    // ---------------------------------------------------------------------

    struct Project {
        string name;
        address payee; // 本项目允许的收款地址（服务商）
        uint256 allocated; // 已分配给本项目的总额
        uint256 reserved; // 已预占、尚未结算
        uint256 spent; // 已实际付出
    }

    /// @notice 付款承诺：锁定的上限只能由指定供应商在截止前兑现
    struct Reservation {
        address agent; // 发起锁款的 Agent
        address vendor; // 唯一能结算的供应商
        uint32 projectId;
        uint64 deadline; // 截止时间（秒）
        bool open;
        uint256 amount; // 锁定上限
        bytes32 orderId; // 订单号
    }

    /// @notice 操作类型（用于活动记录）
    enum Action {
        Deposit,
        Allocate,
        Reallocate,
        Reserve,
        Settle,
        Release,
        Pay
    }

    /// @notice 拦截原因
    enum Reason {
        None,
        NotAgent, // 调用者不是任何项目的 Agent
        InsufficientAvailable, // 可用余额不足
        FundsReserved, // 想调走的钱已被预占
        NotVendor, // 不是这笔承诺指定的供应商
        ReservationClosed, // 承诺已结算或释放
        ExceedsReservation, // 实际花费超过锁定上限
        UnknownProject, // 项目不存在
        CommitmentActive, // 承诺还没到期，不能取消
        CommitmentExpired // 承诺已过期，不能再结算
    }

    /// @notice 一条活动记录（链上环形缓冲区，控制台刷新也能完整恢复）
    struct Activity {
        uint64 time;
        uint64 blockNumber;
        Action action;
        Reason reason; // None 表示成功
        address actor;
        uint32 fromProject;
        uint32 toProject;
        uint256 amount;
        uint256 refId; // 预占编号（预占相关操作）
    }

    struct ProjectView {
        uint256 id;
        string name;
        address payee;
        uint256 allocated;
        uint256 reserved;
        uint256 spent;
        uint256 available;
    }

    // ---------------------------------------------------------------------
    // 存储
    // ---------------------------------------------------------------------

    uint256 public constant ACTIVITY_SIZE = 40;

    address public owner; // 财务管理员
    uint256 public unallocated; // 金库里尚未分配给任何项目的余额

    Project[] private _projects;
    mapping(address => uint256) private _agentProject; // agent => projectId + 1（0 表示不是 Agent）
    mapping(address => string) public agentName;
    Reservation[] private _reservations;

    Activity[ACTIVITY_SIZE] private _activities;
    uint256 public activityCount;

    bool private _locked;

    // ---------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------

    event Deposited(address indexed from, uint256 amount);
    event ProjectCreated(uint256 indexed projectId, string name, address payee);
    event AgentAdded(address indexed agent, uint256 indexed projectId, string name);
    event Allocated(uint256 indexed projectId, uint256 amount);
    event Reallocated(uint256 indexed fromProject, uint256 indexed toProject, uint256 amount);
    event Reserved(uint256 indexed reservationId, uint256 indexed projectId, address indexed agent, uint256 amount);
    event Settled(
        uint256 indexed reservationId, uint256 indexed projectId, address indexed agent, uint256 actual, uint256 released
    );
    event Released(uint256 indexed reservationId, uint256 indexed projectId, uint256 amount);
    /// @notice 付款承诺已锁定：供应商看到这条事件就可以开工
    event Committed(uint256 indexed reservationId, address indexed vendor, bytes32 indexed orderId, uint256 deadline);
    event Paid(uint256 indexed projectId, address indexed agent, address indexed payee, uint256 amount);
    /// @notice 被合约拦下的操作：状态不变，原因写在链上，审计方可查
    event Rejected(
        Action indexed action, Reason indexed reason, address indexed actor, uint256 fromProject, uint256 toProject, uint256 amount
    );

    // ---------------------------------------------------------------------
    // 错误（只用于管理配置类的硬错误；业务拦截一律走 Rejected 事件）
    // ---------------------------------------------------------------------

    error NotOwner();
    error Reentrancy();
    error TransferFailed();
    error BadInput();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        _deposit();
    }

    // ---------------------------------------------------------------------
    // 财务（owner）
    // ---------------------------------------------------------------------

    function deposit() external payable {
        _deposit();
    }

    function createProject(string calldata name, address payee) external onlyOwner returns (uint256 projectId) {
        if (payee == address(0)) revert BadInput();
        projectId = _projects.length;
        _projects.push(Project({name: name, payee: payee, allocated: 0, reserved: 0, spent: 0}));
        emit ProjectCreated(projectId, name, payee);
    }

    function addAgent(address agent, uint256 projectId, string calldata name) external onlyOwner {
        if (projectId >= _projects.length || agent == address(0)) revert BadInput();
        _agentProject[agent] = projectId + 1;
        agentName[agent] = name;
        emit AgentAdded(agent, projectId, name);
    }

    /// @notice 从金库未分配余额里给项目分配预算
    function allocate(uint256 projectId, uint256 amount) external onlyOwner returns (bool) {
        if (projectId >= _projects.length) return _reject(Action.Allocate, Reason.UnknownProject, projectId, projectId, amount, 0);
        if (amount > unallocated) {
            return _reject(Action.Allocate, Reason.InsufficientAvailable, projectId, projectId, amount, 0);
        }
        unallocated -= amount;
        _projects[projectId].allocated += amount;
        emit Allocated(projectId, amount);
        _record(Action.Allocate, Reason.None, projectId, projectId, amount, 0);
        return true;
    }

    /// @notice 项目间调拨：只能调走「未花且未预占」的部分
    function reallocate(uint256 fromProject, uint256 toProject, uint256 amount) external onlyOwner returns (bool) {
        if (fromProject >= _projects.length || toProject >= _projects.length || fromProject == toProject) {
            return _reject(Action.Reallocate, Reason.UnknownProject, fromProject, toProject, amount, 0);
        }
        Project storage from = _projects[fromProject];
        uint256 free = _available(from);
        if (amount > free) {
            // 区分原因：如果算上预占的钱就够，说明是「钱被预占了」
            Reason reason = amount <= free + from.reserved ? Reason.FundsReserved : Reason.InsufficientAvailable;
            return _reject(Action.Reallocate, reason, fromProject, toProject, amount, 0);
        }
        from.allocated -= amount;
        _projects[toProject].allocated += amount;
        emit Reallocated(fromProject, toProject, amount);
        _record(Action.Reallocate, Reason.None, fromProject, toProject, amount, 0);
        return true;
    }

    // ---------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------

    /// @notice Agent 锁定一笔付款承诺：绑定本项目的供应商、订单号和有效期，返回承诺编号；被拒时返回 type(uint256).max
    function reserve(uint256 amount, bytes32 orderId, uint256 ttlSeconds) external returns (uint256 reservationId) {
        uint256 pid = _agentProject[msg.sender];
        if (pid == 0) {
            _reject(Action.Reserve, Reason.NotAgent, 0, 0, amount, 0);
            return type(uint256).max;
        }
        pid -= 1;
        Project storage p = _projects[pid];
        if (amount == 0 || amount > _available(p)) {
            _reject(Action.Reserve, Reason.InsufficientAvailable, pid, pid, amount, 0);
            return type(uint256).max;
        }
        if (ttlSeconds == 0) ttlSeconds = 600;
        p.reserved += amount;
        reservationId = _reservations.length;
        _reservations.push(
            Reservation({
                agent: msg.sender,
                vendor: p.payee,
                projectId: uint32(pid),
                deadline: uint64(block.timestamp + ttlSeconds),
                open: true,
                amount: amount,
                orderId: orderId
            })
        );
        emit Reserved(reservationId, pid, msg.sender, amount);
        emit Committed(reservationId, p.payee, orderId, block.timestamp + ttlSeconds);
        _record(Action.Reserve, Reason.None, pid, pid, amount, reservationId);
    }

    /// @notice 供应商按实际用量兑现承诺：截止前只有指定供应商能调用，不超过上限，只能一次；剩余自动释放回项目
    function settle(uint256 reservationId, uint256 actual) external nonReentrant returns (bool) {
        if (reservationId >= _reservations.length) {
            return _reject(Action.Settle, Reason.ReservationClosed, 0, 0, actual, reservationId);
        }
        Reservation storage r = _reservations[reservationId];
        uint256 pid = r.projectId;
        if (r.vendor != msg.sender) return _reject(Action.Settle, Reason.NotVendor, pid, pid, actual, reservationId);
        if (!r.open) return _reject(Action.Settle, Reason.ReservationClosed, pid, pid, actual, reservationId);
        if (block.timestamp > r.deadline) {
            return _reject(Action.Settle, Reason.CommitmentExpired, pid, pid, actual, reservationId);
        }
        if (actual > r.amount) return _reject(Action.Settle, Reason.ExceedsReservation, pid, pid, actual, reservationId);

        Project storage p = _projects[pid];
        uint256 released = r.amount - actual;
        r.open = false;
        p.reserved -= r.amount;
        p.spent += actual;
        p.allocated -= actual; // 已花的钱离开金库，留在原项目的账上（spent）

        emit Settled(reservationId, pid, r.agent, actual, released);
        _record(Action.Settle, Reason.None, pid, pid, actual, reservationId);
        if (released > 0) {
            emit Released(reservationId, pid, released);
            _record(Action.Release, Reason.None, pid, pid, released, reservationId);
        }
        _send(p.payee, actual);
        return true;
    }

    /// @notice 释放承诺：到期前只有供应商能主动放弃；到期后任何人都能释放（Agent 和财务在到期前都取消不了）
    function release(uint256 reservationId) external returns (bool) {
        if (reservationId >= _reservations.length) {
            return _reject(Action.Release, Reason.ReservationClosed, 0, 0, 0, reservationId);
        }
        Reservation storage r = _reservations[reservationId];
        uint256 pid = r.projectId;
        if (!r.open) return _reject(Action.Release, Reason.ReservationClosed, pid, pid, r.amount, reservationId);
        if (block.timestamp <= r.deadline && msg.sender != r.vendor) {
            return _reject(Action.Release, Reason.CommitmentActive, pid, pid, r.amount, reservationId);
        }
        r.open = false;
        _projects[pid].reserved -= r.amount;
        emit Released(reservationId, pid, r.amount);
        _record(Action.Release, Reason.None, pid, pid, r.amount, reservationId);
        return true;
    }

    /// @notice 固定价格的直接付款（不经过预占），从可用余额扣
    function pay(uint256 amount) external nonReentrant returns (bool) {
        uint256 pid = _agentProject[msg.sender];
        if (pid == 0) return _reject(Action.Pay, Reason.NotAgent, 0, 0, amount, 0);
        pid -= 1;
        Project storage p = _projects[pid];
        if (amount == 0 || amount > _available(p)) return _reject(Action.Pay, Reason.InsufficientAvailable, pid, pid, amount, 0);
        p.spent += amount;
        p.allocated -= amount;
        emit Paid(pid, msg.sender, p.payee, amount);
        _record(Action.Pay, Reason.None, pid, pid, amount, 0);
        _send(p.payee, amount);
        return true;
    }

    // ---------------------------------------------------------------------
    // 只读
    // ---------------------------------------------------------------------

    function projectCount() external view returns (uint256) {
        return _projects.length;
    }

    /// @notice 控制台一张表：项目、已分配、已预占、已花、可用
    function getProjects() external view returns (ProjectView[] memory views) {
        views = new ProjectView[](_projects.length);
        for (uint256 i = 0; i < _projects.length; i++) {
            Project storage p = _projects[i];
            views[i] = ProjectView({
                id: i,
                name: p.name,
                payee: p.payee,
                allocated: p.allocated + p.spent, // 展示口径：累计分配 = 当前持有 + 已花
                reserved: p.reserved,
                spent: p.spent,
                available: _available(p)
            });
        }
    }

    function getReservation(uint256 reservationId) external view returns (Reservation memory) {
        return _reservations[reservationId];
    }

    function reservationCount() external view returns (uint256) {
        return _reservations.length;
    }

    function projectOf(address agent) external view returns (bool isAgent, uint256 projectId) {
        uint256 pid = _agentProject[agent];
        return (pid != 0, pid == 0 ? 0 : pid - 1);
    }

    /// @notice 最近的活动记录，最新的在最前面
    function getActivities() external view returns (Activity[] memory list) {
        uint256 n = activityCount < ACTIVITY_SIZE ? activityCount : ACTIVITY_SIZE;
        list = new Activity[](n);
        for (uint256 i = 0; i < n; i++) {
            list[i] = _activities[(activityCount - 1 - i) % ACTIVITY_SIZE];
        }
    }

    // ---------------------------------------------------------------------
    // 内部
    // ---------------------------------------------------------------------

    /// @dev 可用 = 当前持有 - 已预占（已花的已从 allocated 扣掉）
    function _available(Project storage p) internal view returns (uint256) {
        return p.allocated - p.reserved;
    }

    function _deposit() internal {
        unallocated += msg.value;
        emit Deposited(msg.sender, msg.value);
        _record(Action.Deposit, Reason.None, 0, 0, msg.value, 0);
    }

    function _reject(Action action, Reason reason, uint256 fromProject, uint256 toProject, uint256 amount, uint256 refId)
        internal
        returns (bool)
    {
        emit Rejected(action, reason, msg.sender, fromProject, toProject, amount);
        _record(action, reason, fromProject, toProject, amount, refId);
        return false;
    }

    function _record(Action action, Reason reason, uint256 fromProject, uint256 toProject, uint256 amount, uint256 refId)
        internal
    {
        _activities[activityCount % ACTIVITY_SIZE] = Activity({
            time: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            action: action,
            reason: reason,
            actor: msg.sender,
            fromProject: uint32(fromProject),
            toProject: uint32(toProject),
            amount: amount,
            refId: refId
        });
        activityCount += 1;
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
