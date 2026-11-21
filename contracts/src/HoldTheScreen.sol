// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title HoldTheScreen 霸屏
/// @notice 用 Harberger 税给大屏展示位定价：霸主自己定价，按持有时间交税，
///         任何人付霸主的定价就能当场买走广告位。税金懒结算，在同一笔交易里分给场地方和奖池。
contract HoldTheScreen {
    // ---------------------------------------------------------------------
    // 常量
    // ---------------------------------------------------------------------

    /// @notice 广告位数量：0 主位，1、2 小格
    uint256 public constant SLOT_COUNT = 3;
    /// @notice 每秒税率（基点）：100 = 每秒 1%，价格为 P 时霸屏 100 秒交 P
    uint256 public constant TAX_BPS_PER_SECOND = 100;
    /// @notice 最低定价
    uint256 public constant MIN_PRICE = 0.001 ether;
    uint256 public constant MAX_NICKNAME_BYTES = 48;
    uint256 public constant MAX_CONTENT_BYTES = 300;
    uint8 public constant KIND_TEXT = 0;
    uint8 public constant KIND_IMAGE = 1;
    uint8 public constant KIND_VIDEO = 2;
    uint256 private constant BPS = 10_000;

    // ---------------------------------------------------------------------
    // 存储
    // ---------------------------------------------------------------------

    struct Slot {
        address holder;
        uint8 kind;
        uint64 lastSettled;
        uint256 price;
        uint256 deposit;
        string nickname;
        string content;
    }

    /// @notice 给前端读的广告位快照（按当前区块时间实时计算）
    struct SlotView {
        address holder;
        uint8 kind;
        uint256 price;
        uint256 depositLeft;
        uint256 secondsLeft;
        uint256 lastSettled;
        string nickname;
        string content;
    }

    address public owner;
    address public venue;
    uint256 public venueShareBps;
    uint256 public prizePool;
    uint256 public totalTakeovers;

    mapping(uint256 => Slot) private _slots;
    /// @notice 每个地址累计霸屏秒数（结算时累加），用于排行榜
    mapping(address => uint256) public totalHeldSeconds;
    /// @notice 转账失败时记账，之后可以自己提取
    mapping(address => uint256) public pendingWithdrawals;

    bool private _locked;

    // ---------------------------------------------------------------------
    // 事件
    // ---------------------------------------------------------------------

    event TakeOver(
        uint256 indexed slotId,
        address indexed prevHolder,
        address indexed newHolder,
        string nickname,
        uint8 kind,
        string content,
        uint256 newPrice,
        uint256 pricePaid
    );
    event TaxPaid(uint256 indexed slotId, address indexed holder, uint256 toVenue, uint256 toPrizePool);
    event Foreclosed(uint256 indexed slotId, address indexed holder);
    event PriceChanged(uint256 indexed slotId, address indexed holder, uint256 newPrice);
    event ToppedUp(uint256 indexed slotId, address indexed holder, uint256 amount);
    event PlayersFunded(uint256 count, uint256 amountEach);
    event PrizeWithdrawn(address indexed to, uint256 amount);
    event VenueUpdated(address indexed venue, uint256 venueShareBps);

    // ---------------------------------------------------------------------
    // 错误
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotHolder();
    error InvalidSlot();
    error InvalidKind();
    error PriceTooLow();
    error NicknameTooLong();
    error ContentTooLong();
    error EmptyContent();
    error InsufficientPayment();
    error InvalidShare();
    error ValueMismatch();
    error TransferFailed();
    error Reentrancy();
    error NothingToWithdraw();

    // ---------------------------------------------------------------------
    // 修饰符
    // ---------------------------------------------------------------------

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

    modifier validSlot(uint256 slotId) {
        if (slotId >= SLOT_COUNT) revert InvalidSlot();
        _;
    }

    constructor(address venue_, uint256 venueShareBps_) {
        if (venueShareBps_ > BPS) revert InvalidShare();
        owner = msg.sender;
        venue = venue_;
        venueShareBps = venueShareBps_;
        emit VenueUpdated(venue_, venueShareBps_);
    }

    // ---------------------------------------------------------------------
    // 玩家操作
    // ---------------------------------------------------------------------

    /// @notice 抢屏：付当前霸主的定价，附上的其余金额作为自己的预存税金
    function takeOver(uint256 slotId, string calldata nickname, uint8 kind, string calldata content, uint256 newPrice)
        external
        payable
        nonReentrant
        validSlot(slotId)
    {
        if (kind > KIND_VIDEO) revert InvalidKind();
        if (newPrice < MIN_PRICE) revert PriceTooLow();
        if (bytes(nickname).length > MAX_NICKNAME_BYTES) revert NicknameTooLong();
        if (bytes(content).length == 0) revert EmptyContent();
        if (bytes(content).length > MAX_CONTENT_BYTES) revert ContentTooLong();

        _settle(slotId);

        Slot storage s = _slots[slotId];
        address prev = s.holder;
        uint256 cost = s.price; // 无主时为 0
        // 必须付清定价，并且留下大于 0 的预存税金
        if (msg.value <= cost) revert InsufficientPayment();

        uint256 refund = s.deposit;

        s.holder = msg.sender;
        s.kind = kind;
        s.lastSettled = uint64(block.timestamp);
        s.price = newPrice;
        s.deposit = msg.value - cost;
        s.nickname = nickname;
        s.content = content;
        totalTakeovers += 1;

        emit TakeOver(slotId, prev, msg.sender, nickname, kind, content, newPrice, cost);

        // 定价 + 没用完的税金，打给上一任霸主
        if (prev != address(0) && cost + refund > 0) {
            _pay(prev, cost + refund);
        }
    }

    /// @notice 霸主追加预存税金
    function topUp(uint256 slotId) external payable nonReentrant validSlot(slotId) {
        _settle(slotId);
        Slot storage s = _slots[slotId];
        if (s.holder != msg.sender) revert NotHolder();
        s.deposit += msg.value;
        emit ToppedUp(slotId, msg.sender, msg.value);
    }

    /// @notice 霸主改价（可以改高也可以改低）
    function setPrice(uint256 slotId, uint256 newPrice) external nonReentrant validSlot(slotId) {
        if (newPrice < MIN_PRICE) revert PriceTooLow();
        _settle(slotId);
        Slot storage s = _slots[slotId];
        if (s.holder != msg.sender) revert NotHolder();
        s.price = newPrice;
        emit PriceChanged(slotId, msg.sender, newPrice);
    }

    /// @notice 任何人都可以触发某个广告位的税金结算
    function settle(uint256 slotId) external nonReentrant validSlot(slotId) {
        _settle(slotId);
    }

    /// @notice 转账失败时被记账的金额，自己来提取
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // 只读
    // ---------------------------------------------------------------------

    /// @notice 一次返回所有广告位的实时状态（税金按当前区块时间计算）
    function getSlots() external view returns (SlotView[] memory views) {
        views = new SlotView[](SLOT_COUNT);
        for (uint256 i = 0; i < SLOT_COUNT; i++) {
            views[i] = _view(i);
        }
    }

    function getSlot(uint256 slotId) external view validSlot(slotId) returns (SlotView memory) {
        return _view(slotId);
    }

    // ---------------------------------------------------------------------
    // 主持人
    // ---------------------------------------------------------------------

    /// @notice 批量给新玩家发币（一笔交易发给多人）
    function fundPlayers(address[] calldata players, uint256 amountEach) external payable nonReentrant onlyOwner {
        if (msg.value != amountEach * players.length) revert ValueMismatch();
        for (uint256 i = 0; i < players.length; i++) {
            (bool ok,) = players[i].call{value: amountEach}("");
            if (!ok) revert TransferFailed();
        }
        emit PlayersFunded(players.length, amountEach);
    }

    /// @notice 发放奖池（演示最后发给霸屏时长第一名）
    function withdrawPrize(address to, uint256 amount) external nonReentrant onlyOwner {
        if (amount > prizePool) revert InsufficientPayment();
        prizePool -= amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PrizeWithdrawn(to, amount);
    }

    function setVenue(address venue_, uint256 venueShareBps_) external onlyOwner {
        if (venueShareBps_ > BPS) revert InvalidShare();
        venue = venue_;
        venueShareBps = venueShareBps_;
        emit VenueUpdated(venue_, venueShareBps_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // 内部
    // ---------------------------------------------------------------------

    /// @dev 懒结算：把从上次结算到现在欠的税一次算清；税金用完就强制断供（广告位变无主）
    function _settle(uint256 slotId) internal {
        Slot storage s = _slots[slotId];
        address holder = s.holder;
        if (holder == address(0)) return;

        uint256 elapsed = block.timestamp - s.lastSettled;
        if (elapsed == 0) return;

        uint256 taxPerSecond = (s.price * TAX_BPS_PER_SECOND) / BPS;
        uint256 owed = taxPerSecond * elapsed;

        if (owed >= s.deposit) {
            // 税金用完：只收剩余押金，按押金能撑的秒数计入霸屏时长，然后清空广告位
            uint256 paid = s.deposit;
            uint256 heldSeconds = taxPerSecond == 0 ? elapsed : paid / taxPerSecond;
            totalHeldSeconds[holder] += heldSeconds;
            delete _slots[slotId];
            _distributeTax(slotId, holder, paid);
            emit Foreclosed(slotId, holder);
        } else {
            s.deposit -= owed;
            s.lastSettled = uint64(block.timestamp);
            totalHeldSeconds[holder] += elapsed;
            _distributeTax(slotId, holder, owed);
        }
    }

    /// @dev 税金分账：场地方按比例直接到账，其余进奖池
    function _distributeTax(uint256 slotId, address holder, uint256 amount) internal {
        if (amount == 0) return;
        uint256 toVenue = venue == address(0) ? 0 : (amount * venueShareBps) / BPS;
        uint256 toPool = amount - toVenue;
        prizePool += toPool;
        emit TaxPaid(slotId, holder, toVenue, toPool);
        if (toVenue > 0) _pay(venue, toVenue);
    }

    /// @dev 转账失败（比如对方是拒收的合约）就记账，避免一个人卡住整个广告位
    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) pendingWithdrawals[to] += amount;
    }

    function _view(uint256 slotId) internal view returns (SlotView memory v) {
        Slot storage s = _slots[slotId];
        if (s.holder == address(0)) return v;

        uint256 taxPerSecond = (s.price * TAX_BPS_PER_SECOND) / BPS;
        uint256 owed = taxPerSecond * (block.timestamp - s.lastSettled);
        if (owed >= s.deposit) return v; // 已经该断供了，按无主展示

        v.holder = s.holder;
        v.kind = s.kind;
        v.price = s.price;
        v.depositLeft = s.deposit - owed;
        v.secondsLeft = taxPerSecond == 0 ? type(uint256).max : v.depositLeft / taxPerSecond;
        v.lastSettled = s.lastSettled;
        v.nickname = s.nickname;
        v.content = s.content;
    }
}
