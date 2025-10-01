// Importação dos módulos necessários
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises; // Usando a versão de promessas do 'fs'
require('dotenv').config();

// Inicialização do aplicativo Express
const app = express();
const port = process.env.PORT || 3002;

// --- Middlewares ---
app.use(cors()); 
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// --- Configuração do Banco de Dados JSON para Despesas ---
const DB_PATH = path.join(__dirname, 'expenses.json');

// Função para ler as despesas do "banco de dados"
const readExpenses = async () => {
    try {
        await fs.access(DB_PATH);
        const data = await fs.readFile(DB_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // Se o arquivo não existir, retorna um array vazio
        return [];
    }
};

// Função para escrever as despesas no "banco de dados"
const writeExpenses = async (data) => {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
};

// Validação da chave da API do Asaas
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
if (!ASAAS_API_KEY) {
    console.error("ERRO: A variável de ambiente ASAAS_API_KEY não está definida.");
    process.exit(1);
}

// Configuração do Axios para se comunicar com a API do Asaas
const asaasAPI = axios.create({
    baseURL: 'https://api.asaas.com/v3',
    headers: {
        'access_token': ASAAS_API_KEY,
        'Content-Type': 'application/json'
    }
});

// --- ROTAS DA API ---

// Rota para criar um novo cliente e uma cobrança (mensalidade)
app.post('/api/create-customer-and-payment', async (req, res) => {
    const { name, cpfCnpj, value, dueDate } = req.body;
    if (!name || !cpfCnpj || !value || !dueDate) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios." });
    }
    try {
        const customerResponse = await asaasAPI.post('/customers', { name, cpfCnpj });
        const customerId = customerResponse.data.id;

        const paymentResponse = await asaasAPI.post('/payments', {
            customer: customerId,
            billingType: 'BOLETO',
            value,
            dueDate,
            description: `Mensalidade da creche para ${name}`
        });
        res.status(201).json({ customer: customerResponse.data, payment: paymentResponse.data });
    } catch (error) {
        console.error('Erro ao criar cliente ou pagamento:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao processar a criação no Asaas.', details: error.response?.data });
    }
});

// Rota para obter o status de todos os alunos
app.get('/api/students-status', async (req, res) => {
    try {
        const { data: { data: customers } } = await asaasAPI.get('/customers?limit=100');
        if (!customers || customers.length === 0) return res.json({ students: [] });

        const studentStatusPromises = customers.map(async (customer) => {
            const { data: { data: payments } } = await asaasAPI.get(`/payments?customer=${customer.id}`);
            
            let status = 'ADIMPLENTE';
            let nextDueDate = 'Em dia';
            let monthlyFee = 0;

            if (payments.some(p => p.status === 'OVERDUE')) {
                status = 'INADIMPLENTE';
            }
            
            const pending = payments.filter(p => ['PENDING', 'OVERDUE'].includes(p.status)).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

            if (pending.length > 0) {
                nextDueDate = pending[0].dueDate;
                monthlyFee = pending[0].value;
            } else if (payments.length > 0) {
                monthlyFee = payments.sort((a, b) => new Date(b.paymentDate || b.dueDate) - new Date(a.paymentDate || a.dueDate))[0].value;
            }
            
            return { id: customer.id, name: customer.name, status, nextDueDate, monthlyFee };
        });

        const students = await Promise.all(studentStatusPromises);
        res.json({ students });
    } catch (error) {
        console.error('Erro ao obter status dos alunos:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao obter status dos alunos.' });
    }
});

// Rota para criar uma receita avulsa (matrícula, material, etc.)
app.post('/api/create-revenue', async (req, res) => {
    const { customerId, description, value, dueDate, category } = req.body;
    if (!customerId || !description || !value || !dueDate || !category) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios." });
    }
    try {
        const paymentResponse = await asaasAPI.post('/payments', {
            customer: customerId,
            billingType: 'BOLETO',
            value,
            dueDate,
            description: `[${category}] ${description}`
        });
        res.status(201).json({ payment: paymentResponse.data });
    } catch (error) {
        console.error('Erro ao criar nova receita:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao criar nova receita no Asaas.', details: error.response?.data });
    }
});

// Rota para obter e criar despesas
app.route('/api/expenses')
    .get(async (req, res) => {
        try {
            const expenses = await readExpenses();
            res.json({ expenses });
        } catch (error) {
            console.error('Erro ao ler despesas:', error);
            res.status(500).json({ message: 'Erro ao buscar despesas.' });
        }
    })
    .post(async (req, res) => {
        const { description, value, category, date } = req.body;
        if (!description || !value || !category || !date) {
            return res.status(400).json({ message: 'Todos os campos são obrigatórios para despesa.' });
        }
        try {
            const expenses = await readExpenses();
            const newExpense = { id: Date.now().toString(), ...req.body };
            expenses.push(newExpense);
            await writeExpenses(expenses);
            res.status(201).json(newExpense);
        } catch (error) {
            console.error('Erro ao salvar despesa:', error);
            res.status(500).json({ message: 'Erro ao salvar despesa.' });
        }
    });

// Rota para os dados do dashboard
app.get('/api/dashboard-summary', async (req, res) => {
    try {
        const { data: { data: payments } } = await asaasAPI.get('/payments?limit=100');
        const expenses = await readExpenses();

        let totalRevenue = 0;
        const customerIds = new Set();
        const monthlyRevenue = {};

        payments.forEach(p => {
            customerIds.add(p.customer);
            // CORREÇÃO: Adicionada verificação para p.paymentDate para evitar crashes
            if (p.status === 'RECEIVED' && p.paymentDate) {
                totalRevenue += p.value;
                const month = p.paymentDate.substring(0, 7);
                monthlyRevenue[month] = (monthlyRevenue[month] || 0) + p.value;
            }
        });
        
        const totalExpenses = expenses.reduce((sum, exp) => sum + parseFloat(exp.value), 0);

        const evolutionChart = { labels: [], data: [] };
        for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const monthKey = d.toISOString().substring(0, 7);
            evolutionChart.labels.push(new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(d));
            evolutionChart.data.push(monthlyRevenue[monthKey] || 0);
        }

        const expenseChart = { labels: [], data: [] };
        const expensesByCategory = expenses.reduce((acc, exp) => {
            acc[exp.category] = (acc[exp.category] || 0) + parseFloat(exp.value);
            return acc;
        }, {});
        expenseChart.labels = Object.keys(expensesByCategory);
        expenseChart.data = Object.values(expensesByCategory);

        res.json({
            totalRevenue,
            totalExpenses,
            netProfit: totalRevenue - totalExpenses,
            totalCustomers: customerIds.size,
            evolutionChart,
            expenseChart
        });
    } catch (error) {
        console.error('Erro ao buscar resumo do dashboard:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao buscar dados do dashboard.' });
    }
});


// ROTA NOVA: Extrato Financeiro Unificado
app.get('/api/financial-statement', async (req, res) => {
    try {
        // 1. Buscar todas as receitas recebidas do Asaas
        const { data: customersData } = await asaasAPI.get('/customers?limit=100');
        const customerMap = new Map(customersData.data.map(c => [c.id, c.name]));
        
        const { data: paymentsData } = await asaasAPI.get('/payments?status=RECEIVED&limit=100');
        const revenues = paymentsData.data.map(p => ({
            type: 'revenue',
            date: p.paymentDate,
            description: p.description,
            category: p.description.match(/\[(.*?)\]/)?.[1] || 'Mensalidade',
            value: p.value,
            customerName: customerMap.get(p.customer) || 'N/A'
        }));

        // 2. Buscar todas as despesas do nosso arquivo
        const expenses = await readExpenses();
        const formattedExpenses = expenses.map(e => ({
            type: 'expense',
            date: e.date,
            description: e.description,
            category: e.category,
            value: parseFloat(e.value),
            customerName: 'N/A'
        }));

        // 3. Unificar, ordenar por data e enviar
        const statement = [...revenues, ...formattedExpenses];
        statement.sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json({ statement });

    } catch (error) {
        console.error('Erro ao gerar extrato financeiro:', error.response?.data || error.message);
        res.status(500).json({ message: 'Erro ao gerar extrato financeiro.' });
    }
});


// Rota principal para servir o frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// Inicia o servidor
app.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
});
