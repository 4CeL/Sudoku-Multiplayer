import random
import copy

class SudokuEngine:
    def __init__(self):
        self.size = 9
        self.box_size = 3

    def generate_puzzle(self, difficulty="medium"):
        """
        Generates a valid Sudoku puzzle and its full solution.
        Difficulties: 'easy', 'medium', 'hard'
        """
        # 1. Generate full solved 9x9 board
        solution_board = [[0 for _ in range(self.size)] for _ in range(self.size)]
        self._fill_board(solution_board)

        # 2. Clone for puzzle and carve out clues
        puzzle_board = copy.deepcopy(solution_board)
        
        # Number of cells to remove based on difficulty
        difficulty_removals = {
            "easy": 34,      # ~47 clues left (quick match)
            "medium": 44,    # ~37 clues left (balanced)
            "hard": 52       # ~29 clues left (challenging)
        }
        cells_to_remove = difficulty_removals.get(difficulty.lower(), 44)

        # Randomly remove cells
        positions = [(r, c) for r in range(self.size) for c in range(self.size)]
        random.shuffle(positions)

        removed = 0
        for r, c in positions:
            if removed >= cells_to_remove:
                break
            puzzle_board[r][c] = 0
            removed += 1

        return {
            "puzzle": puzzle_board,
            "solution": solution_board,
            "difficulty": difficulty
        }

    def _is_valid(self, board, row, col, num):
        # Check row
        for c in range(self.size):
            if board[row][c] == num:
                return False

        # Check col
        for r in range(self.size):
            if board[r][col] == num:
                return False

        # Check 3x3 box
        start_row = (row // self.box_size) * self.box_size
        start_col = (col // self.box_size) * self.box_size
        for r in range(start_row, start_row + self.box_size):
            for c in range(start_col, start_col + self.box_size):
                if board[r][c] == num:
                    return False

        return True

    def _fill_board(self, board):
        """Fills the board completely with a random valid Sudoku solution using backtracking."""
        numbers = list(range(1, 10))
        for r in range(self.size):
            for c in range(self.size):
                if board[r][c] == 0:
                    random.shuffle(numbers)
                    for num in numbers:
                        if self._is_valid(board, r, c, num):
                            board[r][c] = num
                            if self._fill_board(board):
                                return True
                            board[r][c] = 0
                    return False
        return True

    def check_solution(self, player_board, solution_board):
        """Verifies if the player's board is complete and matches the solution."""
        for r in range(self.size):
            for c in range(self.size):
                val = player_board[r][c]
                if val == 0 or val != solution_board[r][c]:
                    return False
        return True

    def evaluate_board(self, player_board, solution_board):
        """
        Returns stats about the player's current board:
        - filled_count
        - total_cells (81)
        - progress_percentage
        - errors_count (filled cells that differ from solution)
        - is_complete_and_correct
        """
        filled = 0
        errors = 0
        for r in range(self.size):
            for c in range(self.size):
                val = player_board[r][c]
                if val != 0:
                    filled += 1
                    if val != solution_board[r][c]:
                        errors += 1

        is_complete = (filled == self.size * self.size) and (errors == 0)
        progress = round((filled / (self.size * self.size)) * 100, 1)

        return {
            "filled": filled,
            "total": self.size * self.size,
            "progress": progress,
            "errors": errors,
            "is_complete": is_complete
        }
