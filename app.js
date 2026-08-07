document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('entropy-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        // generate random entropy score for demo
        const score = Math.floor(Math.random() * 101);
        showResult(score);
    });
});

function showResult(score) {
    const resultBox = document.getElementById('entropy-result');
    if (!resultBox) return;
    resultBox.classList.remove('risk-critical', 'risk-high', 'risk-low', 'hidden');
    
    let levelClass = '';
    if (score >= 80) {
        levelClass = 'risk-low';
    } else if (score >= 60) {
        levelClass = 'risk-high';
    } else {
        levelClass = 'risk-critical';
    }
    resultBox.classList.add(levelClass);
    
    resultBox.innerHTML = `<h3 class="result-title">Entropy Score: ${score}</h3>`;
}
