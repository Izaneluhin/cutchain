// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal mintable ERC-20 for tests. `returnsBool = false` simulates USDT-style tokens
///      whose `transfer` returns nothing; `failTransfers = true` makes `transfer` return false.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    bool public immutable returnsBool;
    bool public failTransfers;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, bool returnsBool_) {
        name = name_;
        symbol = symbol_;
        returnsBool = returnsBool_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFailTransfers(bool v) external {
        failTransfers = v;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool ok) {
        if (failTransfers) {
            if (returnsBool) return false;
            // no-return-style tokens can only signal failure by reverting
            revert("MockERC20: transfer failed");
        }
        _move(msg.sender, to, amount);
        if (returnsBool) return true;
        // Simulate a token that returns no data at all.
        assembly {
            return(0, 0)
        }
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "MockERC20: allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockERC20: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
